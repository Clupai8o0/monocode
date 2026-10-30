import { seeded } from "../seeded";
import { chooseMove, type SearchRequest, type SearchResult } from "./chessAi";

/** Fork: asks the worker for a move, or searches here if it can't start. */

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
const waiting = new Map<number, (result: SearchResult) => void>();
const asked = new Map<number, SearchRequest>();

function searchHere(request: SearchRequest) {
  return chooseMove(request, seeded(request.seed));
}

function fallBack() {
  broken = true;
  worker?.terminate();
  worker = null;
  for (const [id, resolve] of waiting) {
    const request = asked.get(id);
    if (request) {
      resolve(searchHere(request));
    }
  }
  waiting.clear();
  asked.clear();
}

function start() {
  if (worker || broken) {
    return worker;
  }
  try {
    worker = new Worker(new URL("./chessEngine.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (
      event: MessageEvent<{ id: number; result: SearchResult }>,
    ) => {
      const { id, result } = event.data;
      waiting.get(id)?.(result);
      waiting.delete(id);
      asked.delete(id);
    };
    worker.onerror = fallBack;
  } catch {
    broken = true;
  }
  return worker;
}

export function askEngine(request: SearchRequest): Promise<SearchResult> {
  const thread = start();
  if (!thread) {
    return new Promise((resolve) => {
      setTimeout(() => resolve(searchHere(request)), 0);
    });
  }
  return new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    asked.set(id, request);
    thread.postMessage({ id, request });
  });
}
