import type { CacheStrategyName } from "../config.js";
import { cacheAsideStrategy } from "./cacheAside.js";
import { writeThroughStrategy } from "./writeThrough.js";
import { writeBackStrategy } from "./writeBack.js";
import type { CacheStrategy } from "./types.js";

export function createStrategy(name: CacheStrategyName): CacheStrategy {
  switch (name) {
    case "cache-aside":
      return cacheAsideStrategy;
    case "write-through":
      return writeThroughStrategy;
    case "write-back":
      return writeBackStrategy;
  }
}
