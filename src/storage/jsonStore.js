import fs from 'node:fs/promises';
import path from 'node:path';
import { seedDatabase } from './seed.js';

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

export async function createJsonStore(filePath = path.resolve(process.cwd(), 'data', 'db.json')) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let state;
  try {
    const text = await fs.readFile(filePath, 'utf8');
    state = ensureShape(JSON.parse(text));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = seedDatabase();
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  }

  let queue = Promise.resolve();

  async function persist() {
    state.updatedAt = new Date().toISOString();
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2));
    await fs.rename(tempPath, filePath);
  }

  function run(task, shouldPersist) {
    const next = queue.then(async () => {
      const result = await task(state);
      if (shouldPersist) {
        await persist();
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
    transact(task) {
      return run(task, true);
    },
    filePath
  };
}
