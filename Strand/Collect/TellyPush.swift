import Foundation
import WhoopStore

@MainActor
final class TellyPush {
    static let shared = TellyPush()
    static let urlKey = "telly.push.url"

    private static let streams = ["hrSample", "rrInterval", "event", "battery", "skinTempSample", "gravitySample",
                                  "stepSample", "sleepStateSample", "ppgHrSample", "spo2Sample", "respSample"]
    private static let summaries = [
        "dailyMetric": "day >= date('now', 'localtime', '-2 days')",
        "metricSeries": "day >= date('now', 'localtime', '-2 days')",
        "sleepSession": "endTs >= strftime('%s', 'now') - 172800",
        "workout": "startTs >= strftime('%s', 'now') - 172800",
        "liveSession": "startTs >= strftime('%s', 'now') - 172800",
        "pairedDevice": "1",
    ]

    private var busy = false
    private var sent: [String: Data] = [:]

    func kick(_ store: WhoopStore) {
        guard !busy, let url = UserDefaults.standard.string(forKey: Self.urlKey).flatMap(URL.init(string:)) else { return }
        busy = true
        Task {
            defer { busy = false }
            try? await push(store, to: url)
        }
    }

    func push(_ store: WhoopStore, to url: URL) async throws {
        var tables: [String: [[String: Any]]] = [:]
        var cursors: [String: Int64] = [:]
        for t in Self.streams {
            let rows = try await store.jsonRows(
                "SELECT rowid AS _rowid, * FROM \(t) WHERE rowid > coalesce(?, (SELECT max(rowid) FROM \(t)) - 600, 0) ORDER BY rowid LIMIT 2000",
                [try await store.cursor("telly:" + t)])
            if let last = rows.last?["_rowid"] as? Int64 { tables[t] = rows; cursors[t] = last }
        }
        var fresh: [String: Data] = [:]
        for (t, clause) in Self.summaries {
            let rows = try await store.jsonRows("SELECT * FROM \(t) WHERE \(clause)")
            let data = try JSONSerialization.data(withJSONObject: rows, options: .sortedKeys)
            if data != sent[t] { tables[t] = rows; fresh[t] = data }
        }
        guard !tables.isEmpty else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try (JSONSerialization.data(withJSONObject: ["tables": tables]) as NSData)
            .compressed(using: .zlib) as Data
        let (_, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
        for (t, last) in cursors { try await store.setCursor("telly:" + t, Int(last)) }
        sent.merge(fresh) { _, new in new }
    }
}
