/**
 * Asterisk Manager Interface (AMI) wire codec.
 *
 * AMI is a line protocol: an action or an event is a block of `Key: Value`
 * header lines terminated by a blank line (`\r\n\r\n`). There is no length
 * prefix, so a TCP reader has to keep a buffer and emit blocks as the double
 * line break arrives — `parseAmiBuffer` is that reader, deliberately free of
 * socket concerns so it can be exercised against captured wire bytes.
 *
 * Keeping the codec separate from the client means the framing rules (which are
 * where an AMI integration actually breaks) are testable without a PBX.
 */

export type AmiFields = Record<string, string>;

export interface AmiMessage {
  /** Every header, with the first occurrence of a repeated key winning. */
  fields: AmiFields;
  /** Present on asynchronous messages, e.g. `Dial`, `Hangup`, `Newchannel`. */
  event?: string;
  /** Present on replies to an action: `Success`, `Error` or `Follows`. */
  response?: string;
  /** Echoed from the action that produced a reply. */
  actionId?: string;
}

const TERMINATOR = '\r\n\r\n';

/**
 * Splits a raw TCP buffer into complete AMI messages.
 *
 * Returns the still-incomplete tail so a caller can prepend it to the next
 * chunk. A partial message is never emitted: acting on half an event is worse
 * than waiting for the rest of it.
 */
export function parseAmiBuffer(buffer: string): { messages: AmiMessage[]; rest: string } {
  const messages: AmiMessage[] = [];
  let rest = buffer;

  let boundary = rest.indexOf(TERMINATOR);
  while (boundary !== -1) {
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + TERMINATOR.length);
    if (block.trim() !== '') messages.push(parseAmiMessage(block));
    boundary = rest.indexOf(TERMINATOR);
  }

  return { messages, rest };
}

/** Parses a single already-delimited block of `Key: Value` lines. */
export function parseAmiMessage(block: string): AmiMessage {
  const fields: AmiFields = {};

  for (const line of block.split('\r\n')) {
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    // A value may legitimately contain ':'; only the first one is the separator.
    const value = line.slice(separator + 1).replace(/^ /, '');
    if (!(key in fields)) fields[key] = value;
  }

  return {
    fields,
    event: fields.Event,
    response: fields.Response,
    actionId: fields.ActionID,
  };
}

/**
 * Renders an action into the bytes AMI expects.
 *
 * The mandatory `Action` header is passed separately from its parameters so a
 * caller cannot accidentally send an action with no verb.
 */
export function serializeAmiAction(
  verb: string,
  params: Record<string, string | number | undefined> = {},
): string {
  let out = `Action: ${verb}\r\n`;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    out += `${key}: ${value}\r\n`;
  }
  return `${out}\r\n`;
}
