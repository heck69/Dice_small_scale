const { Pool } = require('pg');

let pool;

function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for the Azure PostgreSQL database.');
  }
  return databaseUrl;
}

function createPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: requireDatabaseUrl(),
      ssl: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false'
        ? { rejectUnauthorized: false }
        : undefined,
      max: Number(process.env.DATABASE_POOL_MAX || 10),
    });
  }
  return pool;
}

function assertIdentifier(value, label) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return `"${value}"`;
}

function parseColumns(columns) {
  if (!columns || columns === '*') return '*';
  return columns.split(',').map((column) => {
    const trimmed = column.trim();
    if (trimmed === '*') return '*';
    return assertIdentifier(trimmed, 'column');
  }).join(', ');
}

function createQueryBuilder(tableName) {
  const table = assertIdentifier(tableName, 'table');
  const state = {
    operation: null,
    columns: '*',
    values: null,
    filters: [],
    orderBy: null,
    returnRows: false,
    count: false,
    head: false,
    conflict: null,
  };

  function addFilter(sql, value) {
    state.filters.push({ sql, value });
    return builder;
  }

  function buildWhere(parameters) {
    if (state.filters.length === 0) return '';
    const clauses = state.filters.map((filter) => {
      if (filter.values) {
        const placeholders = filter.values.map((value) => {
          parameters.push(value);
          return `$${parameters.length}`;
        }).join(', ');
        return filter.sql.replace('?', placeholders);
      }
      if (filter.value === undefined) return filter.sql;
      parameters.push(filter.value);
      return filter.sql.replace('?', `$${parameters.length}`);
    });
    return ` where ${clauses.join(' and ')}`;
  }

  async function execute() {
    const parameters = [];
    let text;

    if (state.operation === 'select') {
      const selected = state.head ? '1' : state.columns;
      text = `select ${selected} from ${table}${buildWhere(parameters)}`;
      if (state.orderBy) {
        text += ` order by ${assertIdentifier(state.orderBy.column, 'order column')} ${state.orderBy.ascending ? 'asc' : 'desc'}`;
      }
    } else if (state.operation === 'insert' || state.operation === 'upsert') {
      const rows = Array.isArray(state.values) ? state.values : [state.values];
      if (rows.length === 0) throw new Error('Cannot insert an empty list.');
      const columns = Object.keys(rows[0]);
      const columnSql = columns.map((column) => assertIdentifier(column, 'column')).join(', ');
      const rowSql = rows.map((row) => `(${columns.map((column) => {
        parameters.push(row[column]);
        return `$${parameters.length}`;
      }).join(', ')})`).join(', ');
      text = `insert into ${table} (${columnSql}) values ${rowSql}`;
      if (state.operation === 'upsert') {
        if (state.conflict) {
          const conflictColumns = state.conflict.split(',').map((column) => assertIdentifier(column.trim(), 'conflict column')).join(', ');
          text += ` on conflict (${conflictColumns}) do update set ${columns.map((column) => {
            const identifier = assertIdentifier(column, 'column');
            return `${identifier} = excluded.${identifier}`;
          }).join(', ')}`;
        } else {
          text += ` on conflict do update set ${columns.map((column) => {
            const identifier = assertIdentifier(column, 'column');
            return `${identifier} = excluded.${identifier}`;
          }).join(', ')}`;
        }
      }
      if (state.returnRows) text += ` returning ${state.columns}`;
    } else if (state.operation === 'update') {
      const columns = Object.keys(state.values || {});
      text = `update ${table} set ${columns.map((column) => {
        parameters.push(state.values[column]);
        return `${assertIdentifier(column, 'column')} = $${parameters.length}`;
      }).join(', ')}${buildWhere(parameters)}`;
      if (state.returnRows) text += ` returning ${state.columns}`;
    } else if (state.operation === 'delete') {
      text = `delete from ${table}${buildWhere(parameters)}`;
      if (state.returnRows) text += ` returning ${state.columns}`;
    } else {
      throw new Error('A database operation was not selected.');
    }

    const result = await createPool().query(text, parameters);
    if (state.head) return { data: null, error: null, count: result.rowCount };
    const rows = result.rows;
    if (state.singleMode && rows.length > 1) {
      return {
        data: null,
        error: new Error('Expected one row, got multiple.'),
      };
    }
    return {
      data: state.singleMode ? (rows[0] || null) : (state.returnRows || state.operation === 'select' ? rows : null),
      error: null,
      count: state.operation === 'select' ? result.rowCount : undefined,
    };
  }

  const builder = {
    select(columns = '*', options = {}) {
      if (!state.operation) state.operation = 'select';
      state.columns = parseColumns(columns);
      state.returnRows = state.operation !== 'select' || state.returnRows;
      state.count = options.count === 'exact';
      state.head = options.head === true;
      return builder;
    },
    insert(values) {
      state.operation = 'insert';
      state.values = values;
      return builder;
    },
    upsert(values, options = {}) {
      state.operation = 'upsert';
      state.values = values;
      state.conflict = options.onConflict || null;
      return builder;
    },
    update(values) {
      state.operation = 'update';
      state.values = values;
      return builder;
    },
    delete() {
      state.operation = 'delete';
      return builder;
    },
    eq(column, value) {
      return addFilter(`${assertIdentifier(column, 'filter column')} = ?`, value);
    },
    in(column, values) {
      state.filters.push({
        sql: `${assertIdentifier(column, 'filter column')} in (?)`,
        values,
      });
      return builder;
    },
    is(column, value) {
      if (value !== null) throw new Error('Only null is supported by is().');
      return addFilter(`${assertIdentifier(column, 'filter column')} is null`);
    },
    order(column, options = {}) {
      state.orderBy = { column, ascending: options.ascending !== false };
      return builder;
    },
    maybeSingle() {
      state.singleMode = true;
      return execute();
    },
    single() {
      state.singleMode = true;
      return execute();
    },
  };

  builder.then = (resolve, reject) => execute().then(resolve, reject);
  builder.catch = (reject) => execute().catch(reject);
  builder.finally = (callback) => execute().finally(callback);
  return builder;
}

function createServiceClient() {
  return {
    from(table) {
      return createQueryBuilder(table);
    },
    async rpc(functionName, args = {}) {
      const fn = assertIdentifier(functionName, 'function');
      const keys = Object.keys(args);
      const values = keys.map((key) => args[key]);
      const placeholders = keys.map((key, index) => `$${index + 1}`).join(', ');
      const result = await createPool().query(`select * from public.${fn}(${placeholders})`, values);
      return { data: result.rows, error: null };
    },
  };
}

module.exports = {
  createPool,
  createServiceClient,
};
