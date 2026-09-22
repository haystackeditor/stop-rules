// Settings this service reads from its environment at startup. A missing setting stops the
// process with its name, so a misconfigured deploy fails at once instead of calling the wrong
// host.

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** The base URL of the users and teams API, with no trailing slash. */
export const apiBase: string = required("API_BASE").replace(/\/+$/, "");
