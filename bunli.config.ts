import { defineConfig } from "@bunli/core";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  ...pkg,
});
