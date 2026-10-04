import Foundation
import GRDB

extension WhoopStore {
    public func jsonRows(_ sql: String, _ arguments: [Int?] = []) async throws -> [[String: Any]] {
        try syncRead { db in
            try Row.fetchAll(db, sql: sql, arguments: StatementArguments(arguments)).map { row in
                Dictionary(row.map { name, value -> (String, Any) in
                    switch value.storage {
                    case .null: return (name, NSNull())
                    case .int64(let v): return (name, v)
                    case .double(let v): return (name, v.isFinite ? v as Any : NSNull())
                    case .string(let v): return (name, v)
                    case .blob(let v): return (name, v.base64EncodedString())
                    }
                }, uniquingKeysWith: { first, _ in first })
            }
        }
    }
}
