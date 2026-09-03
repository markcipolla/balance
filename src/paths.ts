import { homedir } from "node:os";
import { join } from "node:path";

// Default location for the config file. Auto-created on first write.
export function defaultConfigPath(): string {
  return join(homedir(), ".balance", "config.json");
}
