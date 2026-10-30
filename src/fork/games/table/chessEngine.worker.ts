import { seeded } from "../seeded";
import { chooseMove, type SearchRequest } from "./chessAi";

/** Fork: the chess engine, off the main thread so the panel stays smooth. */
self.onmessage = (event: MessageEvent<{ id: number; request: SearchRequest }>) => {
  const { id, request } = event.data;
  self.postMessage({ id, result: chooseMove(request, seeded(request.seed)) });
};
