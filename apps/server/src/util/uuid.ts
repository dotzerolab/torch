// Ids come from URLs, headers and cookies: a malformed one is "not found", never a Postgres 22P02 turned into a 500.
// Lower case only. Postgres reads a uuid in any case, but a proxy that hands the URL spelling to Electric would
// create one new shape per spelling of one id; a single canonical form keeps one id to one shape.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
