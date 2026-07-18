import type { GobdeskApi } from "../../shared/api";

declare global {
  interface Window {
    gobdesk: GobdeskApi;
  }
}

export {};
