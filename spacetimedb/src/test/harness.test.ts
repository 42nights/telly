// Runs the module's reducers and views in-process against an in-memory datastore built from the
// module's own table definitions: rows pass through the table's BSATN row type as on the host, and
// primary keys, unique constraints, auto-increment sequences, and btree point/prefix lookups behave
// as the host's do. A reducer that throws rolls back its writes.
// SpacetimeDB runs the module inside its own host, so this is how `bun test` covers its logic.
// ponytail: no Range scans; add them when the module filters an index by range.
import { mock } from "bun:test";
import {
	AlgebraicType,
	BinaryReader,
	BinaryWriter,
	Identity,
	Timestamp,
} from "spacetimedb";

const realConsole = globalThis.console;
mock.module("spacetime:sys@2.0", () => ({
	moduleHooks: Symbol("moduleHooks"),
	row_iter_bsatn_close: () => {},
	console_log: () => {},
}));
mock.module("spacetime:sys@2.1", () => ({}));
// The module imports host-only modules, so it can load only after they are mocked above.
export const mod = await import("../index");
// The server library replaces the global console with one that writes to the host.
globalThis.console = realConsole;

type Row = Record<string, unknown>;
type TableDef = {
	productTypeRef: number;
	primaryKey: number[];
	indexes: { accessorName: string; algorithm: { value: number[] } }[];
	constraints: { data: { value: { columns: number[] } } }[];
	sequences: { column: number }[];
};
type TableSchema = { columns: Record<string, unknown>; tableDef: TableDef };
type Typespace = Parameters<typeof AlgebraicType.makeSerializer>[1];

// A canonical key for any stored value: bigints, strings, numbers, Identity, Timestamp, enums,
// options, and nested objects.
const keyOf = (v: unknown): string => {
	if (typeof v === "bigint") return `${v}n`;
	if (v === undefined) return "u";
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(keyOf).join(",")}]`;
	return `{${Object.keys(v)
		.sort()
		.map((k) => `${k}:${keyOf((v as Row)[k])}`)
		.join(",")}}`;
};

// Rows leave the datastore as copies, as decoded host rows do, so a reducer never mutates storage.
const clone = <T>(v: T): T => {
	if (v === null || typeof v !== "object") return v;
	if (Array.isArray(v)) return v.map(clone) as T;
	const out = Object.create(Object.getPrototypeOf(v));
	for (const k of Object.keys(v)) out[k] = clone((v as Row)[k]);
	return out;
};

class FakeTable {
	rows: Row[] = [];
	next = 1n;
	readonly cols: string[];
	readonly uniques: string[][];
	readonly autoInc: string[];

	constructor(
		readonly name: string,
		schema: TableSchema,
		typespace: Typespace,
	) {
		this.cols = Object.keys(schema.columns);
		const named = (cols: number[]) => cols.map((i) => this.cols[i] as string);
		this.uniques = schema.tableDef.constraints.map((c) =>
			named(c.data.value.columns),
		);
		this.autoInc = schema.tableDef.sequences.map(
			(s) => this.cols[s.column] as string,
		);
		const rowType = typespace.types[
			schema.tableDef.productTypeRef
		] as AlgebraicType;
		const serialize = AlgebraicType.makeSerializer(rowType, typespace);
		const deserialize = AlgebraicType.makeDeserializer(rowType, typespace);
		// Encoding rejects a missing or mistyped column and drops non-columns, as the host does.
		this.encode = (row) => {
			const writer = new BinaryWriter(256);
			serialize(writer, row);
			return deserialize(new BinaryReader(writer.getBuffer())) as Row;
		};
		const primaryKey = keyOf(named(schema.tableDef.primaryKey));
		const handle = this as unknown as Record<string, unknown>;
		for (const index of schema.tableDef.indexes) {
			const cols = named(index.algorithm.value);
			const unique = this.uniques.some((u) => keyOf(u) === keyOf(cols));
			handle[index.accessorName] = unique
				? this.uniqueIndex(cols, keyOf(cols) === primaryKey)
				: this.btreeIndex(cols);
		}
	}

	private readonly encode: (row: Row) => Row;

	private matches(cols: string[], value: unknown) {
		const parts = cols.length === 1 ? [value] : (value as unknown[]);
		return (row: Row) =>
			parts.every((p, i) => keyOf(row[cols[i] as string]) === keyOf(p));
	}

	private uniqueIndex(cols: string[], isPrimaryKey: boolean) {
		const index = {
			find: (value: unknown) => {
				const row = this.rows.find(this.matches(cols, value));
				return row === undefined ? null : clone(row);
			},
			delete: (value: unknown) => {
				const at = this.rows.findIndex(this.matches(cols, value));
				if (at < 0) return false;
				this.rows.splice(at, 1);
				return true;
			},
		};
		if (!isPrimaryKey) return index;
		// The host updates only through the primary key: a delete and an insert of the new row.
		const update = (input: Row) => {
			const row = this.encode(input);
			const key =
				cols.length === 1 ? row[cols[0] as string] : cols.map((c) => row[c]);
			const at = this.rows.findIndex(this.matches(cols, key));
			if (at < 0) throw new Error(`${this.name}: no row to update`);
			const old = this.rows[at] as Row;
			this.rows.splice(at, 1);
			try {
				this.check(row);
			} catch (e) {
				this.rows.splice(at, 0, old);
				throw e;
			}
			this.rows.push(row);
			return input;
		};
		return { ...index, update };
	}

	private btreeIndex(cols: string[]) {
		return {
			filter: (value: unknown) =>
				this.rows
					.filter(this.matches(cols, value))
					.map(clone)
					[Symbol.iterator](),
			delete: (value: unknown) => {
				const before = this.rows.length;
				this.rows = this.rows.filter((r) => !this.matches(cols, value)(r));
				return before - this.rows.length;
			},
		};
	}

	private check(row: Row) {
		for (const u of this.uniques) {
			const key = keyOf(u.map((c) => row[c]));
			if (this.rows.some((r) => keyOf(u.map((c) => r[c])) === key))
				throw new Error(`${this.name}: unique constraint on ${u} violated`);
		}
	}

	insert(input: Row) {
		const out = { ...input };
		for (const c of this.autoInc)
			if (out[c] === 0n) out[c] = this.next++;
			else if (out[c] === 0) out[c] = Number(this.next++);
		const row = this.encode(out);
		this.check(row);
		this.rows.push(row);
		return out;
	}

	iter() {
		return this.rows.map(clone)[Symbol.iterator]();
	}

	count() {
		return BigInt(this.rows.length);
	}

	delete(row: Row) {
		const at = this.rows.findIndex((r) => keyOf(r) === keyOf(row));
		if (at < 0) return false;
		this.rows.splice(at, 1);
		return true;
	}
}

// The view query builder, evaluated in memory: `from.a.where(...).rightSemijoin(from.b, on)`.
type Ref = { side: "l" | "r"; col: string };
type Pred = { left: Ref; right: unknown };
const refs = (side: "l" | "r") =>
	new Proxy(
		{},
		{
			get: (_t, col: string) => ({
				side,
				col,
				eq: (right: unknown): Pred => ({ left: { side, col }, right }),
			}),
		},
	) as Record<string, { eq: (v: unknown) => Pred }>;
const resolve = (v: unknown, l: Row, r?: Row) =>
	typeof v === "object" && v !== null && "side" in v && "col" in v
		? ((v as Ref).side === "l" ? l : (r as Row))[(v as Ref).col]
		: v;
const holds = (p: Pred, l: Row, r?: Row) =>
	keyOf(resolve(p.left, l, r)) === keyOf(resolve(p.right, l, r));

class FakeQuery {
	constructor(readonly rows: () => Row[]) {}
	where(fn: (row: Record<string, { eq: (v: unknown) => Pred }>) => Pred) {
		const p = fn(refs("l"));
		return new FakeQuery(() => this.rows().filter((row) => holds(p, row)));
	}
	rightSemijoin(
		other: FakeQuery,
		on: (
			l: Record<string, { eq: (v: unknown) => Pred }>,
			r: Record<string, { eq: (v: unknown) => Pred }>,
		) => Pred,
	) {
		const p = on(refs("l"), refs("r"));
		const left = this.rows();
		return other.rows().filter((r) => left.some((l) => holds(p, l, r)));
	}
}

export const identity = (n: number) => new Identity(BigInt(n));
export const at = (iso: string) => Timestamp.fromDate(new Date(iso));
export const MODULE = identity(9999);

// A fresh, empty database. `now` is the transaction time of the next call.
export const harness = (start = "2026-01-05T12:00:00Z") => {
	const schemas = mod.default.schemaType.tables as unknown as Record<
		string,
		TableSchema
	>;
	const tables: Record<string, FakeTable> = {};
	const typespace = mod.default.typespace as unknown as Typespace;
	for (const [name, schema] of Object.entries(schemas))
		tables[name] = new FakeTable(name, schema, typespace);
	const from = Object.fromEntries(
		Object.entries(tables).map(([name, t]) => [
			name,
			new FakeQuery(() => t.rows.map(clone)),
		]),
	);
	const h = {
		db: tables,
		now: at(start),
		// Moves the clock forward.
		advance(seconds: number) {
			h.now = new Timestamp(
				h.now.microsSinceUnixEpoch + BigInt(Math.round(seconds * 1e6)),
			);
		},
		// Runs a reducer as `sender` in one transaction: a throw restores every table. As on the
		// host, sequence values that the failed transaction took stay used.
		call<A>(reducer: (ctx: never, args: A) => void, sender: Identity, args: A) {
			const saved = Object.values(tables).map(
				(t) => [t, t.rows.slice()] as const,
			);
			try {
				reducer(
					{
						sender,
						timestamp: h.now,
						db: tables,
						databaseIdentity: MODULE,
					} as never,
					args,
				);
			} catch (e) {
				for (const [t, rows] of saved) t.rows = rows;
				throw e;
			}
		},
		// Evaluates a view as `sender`.
		view<R>(view: (ctx: never) => R, sender: Identity): Row[] {
			return [
				...(view({ sender, db: tables, from } as never) as Iterable<Row>),
			];
		},
		// Every stored row of a table, by its accessor name.
		rows<T = Row>(table: string): T[] {
			return (tables[table] as FakeTable).rows.map(clone) as T[];
		},
	};
	return h;
};
