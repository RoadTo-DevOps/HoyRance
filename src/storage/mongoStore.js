import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { seedDatabase } from './seed.js';

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/bainan';
const META_COLLECTION = 'appMeta';
const META_ID = 'state';

const ENTITY_COLLECTIONS = [
  { stateKey: 'users', collection: 'users', key: 'id' },
  { stateKey: 'sessions', collection: 'sessions', key: 'id', signature: withoutFields(['lastSeenAt']) },
  { stateKey: 'wallets', collection: 'wallets', key: 'id' },
  { stateKey: 'ledgerEntries', collection: 'ledgerEntries', key: 'id' },
  { stateKey: 'symbols', collection: 'symbols', key: 'symbol', signature: durableSymbol },
  { stateKey: 'orders', collection: 'orders', key: 'id' },
  { stateKey: 'trades', collection: 'trades', key: 'id' },
  { stateKey: 'positions', collection: 'positions', key: 'id' },
  { stateKey: 'fundingRecords', collection: 'fundingRecords', key: 'id' },
  { stateKey: 'virtualBalanceAdjustments', collection: 'virtualBalanceAdjustments', key: 'id' },
  { stateKey: 'adminAuditLogs', collection: 'adminAuditLogs', key: 'id' },
  { stateKey: 'notifications', collection: 'notifications', key: 'id' },
  { stateKey: 'liquidationRecords', collection: 'liquidationRecords', key: 'id' }
];

const DESCENDING_CREATED_AT = new Set([
  'trades',
  'fundingRecords',
  'adminAuditLogs',
  'notifications',
  'liquidationRecords'
]);

const ASCENDING_CREATED_AT = new Set([
  'sessions',
  'ledgerEntries',
  'orders',
  'positions',
  'virtualBalanceAdjustments'
]);

const VOLATILE_SYMBOL_FIELDS = new Set([
  'markPrice',
  'indexPrice',
  'lastPrice',
  'priceChange',
  'priceChangePercent',
  'highPrice24h',
  'lowPrice24h',
  'volume24h',
  'openInterest',
  'nextFundingAt',
  'updatedAt'
]);

function clone(value) {
  return structuredClone(value);
}

function ensureShape(state) {
  const seeded = seedDatabase();
  for (const [key, value] of Object.entries(seeded)) {
    if (state[key] === undefined) {
      state[key] = value;
    }
  }
  return state;
}

function withoutFields(fields) {
  const omitted = new Set(fields);
  return (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !omitted.has(key)));
}

function durableSymbol(symbol) {
  return Object.fromEntries(Object.entries(symbol).filter(([key]) => !VOLATILE_SYMBOL_FIELDS.has(key)));
}

function normalizeForHash(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeForHash);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeForHash(value[key])])
    );
  }
  return value;
}

function hashDoc(spec, doc) {
  const source = spec.signature ? spec.signature(doc) : doc;
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(normalizeForHash(source)))
    .digest('hex');
}

function docId(spec, doc) {
  return String(doc[spec.key]);
}

function toMongoDoc(spec, doc) {
  return {
    _id: docId(spec, doc),
    ...clone(doc)
  };
}

function fromMongoDoc(doc) {
  const { _id, ...rest } = doc;
  return rest;
}

function sortItems(stateKey, items) {
  if (DESCENDING_CREATED_AT.has(stateKey)) {
    return items.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
  }
  if (ASCENDING_CREATED_AT.has(stateKey)) {
    return items.sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
  }
  return items;
}

function collectionSignatures(state) {
  const signatures = new Map();
  for (const spec of ENTITY_COLLECTIONS) {
    const map = new Map();
    for (const doc of state[spec.stateKey] ?? []) {
      map.set(docId(spec, doc), hashDoc(spec, doc));
    }
    signatures.set(spec.stateKey, map);
  }
  return signatures;
}

async function hasPersistedState(db) {
  const meta = await db.collection(META_COLLECTION).findOne({ _id: META_ID });
  if (meta) return true;
  const userCount = await db.collection('users').countDocuments({}, { limit: 1 });
  return userCount > 0;
}

async function clearPersistedState(db) {
  await Promise.all([
    db.collection(META_COLLECTION).deleteMany({}),
    ...ENTITY_COLLECTIONS.map((spec) => db.collection(spec.collection).deleteMany({}))
  ]);
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ token: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expiresAt: 1 }),
    db.collection('wallets').createIndex({ userId: 1, type: 1, asset: 1 }, { unique: true }),
    db.collection('orders').createIndex({ userId: 1, createdAt: -1 }),
    db.collection('orders').createIndex({ status: 1, createdAt: 1 }),
    db.collection('trades').createIndex({ userId: 1, createdAt: -1 }),
    db.collection('positions').createIndex({ userId: 1, status: 1 }),
    db.collection('ledgerEntries').createIndex({ 'lines.userId': 1, createdAt: -1 }),
    db.collection('symbols').createIndex({ symbol: 1 }, { unique: true })
  ]);
}

async function persistChangedCollections(db, state, signatures, { force = false } = {}) {
  const pendingWrites = [];
  const nextSignatures = new Map();

  for (const spec of ENTITY_COLLECTIONS) {
    const collection = db.collection(spec.collection);
    const previous = signatures.get(spec.stateKey) ?? new Map();
    const current = new Map();
    const operations = [];

    for (const doc of state[spec.stateKey] ?? []) {
      const id = docId(spec, doc);
      const signature = hashDoc(spec, doc);
      current.set(id, signature);
      if (force || previous.get(id) !== signature) {
        operations.push({
          replaceOne: {
            filter: { _id: id },
            replacement: toMongoDoc(spec, doc),
            upsert: true
          }
        });
      }
    }

    for (const id of previous.keys()) {
      if (!current.has(id)) {
        operations.push({ deleteOne: { filter: { _id: id } } });
      }
    }

    if (operations.length) {
      pendingWrites.push(collection.bulkWrite(operations, { ordered: false }));
    }
    nextSignatures.set(spec.stateKey, current);
  }

  if (!pendingWrites.length && !force) {
    return false;
  }

  state.updatedAt = new Date().toISOString();
  pendingWrites.push(db.collection(META_COLLECTION).replaceOne(
    { _id: META_ID },
    {
      _id: META_ID,
      version: state.version,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt
    },
    { upsert: true }
  ));

  await Promise.all(pendingWrites);
  signatures.clear();
  for (const [stateKey, map] of nextSignatures.entries()) {
    signatures.set(stateKey, map);
  }
  return true;
}

async function loadPersistedState(db, seedState) {
  const seeded = ensureShape(clone(seedState ?? seedDatabase()));
  const state = {
    version: seeded.version,
    createdAt: seeded.createdAt,
    updatedAt: seeded.updatedAt,
    market: seeded.market
  };

  const meta = await db.collection(META_COLLECTION).findOne({ _id: META_ID });
  if (meta) {
    state.version = meta.version ?? state.version;
    state.createdAt = meta.createdAt ?? state.createdAt;
    state.updatedAt = meta.updatedAt ?? state.updatedAt;
  }

  for (const spec of ENTITY_COLLECTIONS) {
    const items = await db.collection(spec.collection).find({}).project({ _id: 0 }).toArray();
    state[spec.stateKey] = sortItems(spec.stateKey, items.map(fromMongoDoc));
  }

  return ensureShape(state);
}

export async function createMongoStore(options = {}) {
  const uri = options.uri || process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 5000)
  });
  await client.connect();

  const db = options.dbName || process.env.MONGODB_DB
    ? client.db(options.dbName || process.env.MONGODB_DB)
    : client.db();

  await ensureIndexes(db);

  const forceImportSeedState = Boolean(options.forceImportSeedState || process.env.MONGODB_FORCE_IMPORT_JSON === 'true');

  let state;
  let signatures;
  if (forceImportSeedState && options.seedState) {
    await clearPersistedState(db);
    state = ensureShape(clone(options.seedState));
    signatures = collectionSignatures(state);
    await persistChangedCollections(db, state, signatures, { force: true });
  } else if (await hasPersistedState(db)) {
    state = await loadPersistedState(db, options.seedState);
    signatures = collectionSignatures(state);
  } else {
    state = ensureShape(clone(options.seedState ?? seedDatabase()));
    signatures = collectionSignatures(state);
    await persistChangedCollections(db, state, signatures, { force: true });
  }

  let queue = Promise.resolve();

  function run(task, shouldPersist) {
    const next = queue.then(async () => {
      const result = await task(state);
      if (shouldPersist) {
        await persistChangedCollections(db, state, signatures);
      }
      return clone(result);
    });
    queue = next.catch(() => {});
    return next;
  }

  return {
    read(task) {
      return run(task, false);
    },
    transact(task, options = {}) {
      return run(task, options.persist !== false);
    },
    async close() {
      await client.close();
    },
    dbName: db.databaseName,
    uri
  };
}
