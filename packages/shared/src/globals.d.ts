// WHATWG `URL` is a global in every runtime this package targets (browsers, Node), but lib ES2022
// with types [] declares none, and lib DOM would let browser-only globals in. Declare just the
// members shared code uses (cluster.ts); widen this only with members both runtimes have.
declare class URL {
  constructor(url: string, base?: string | URL);
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly host: string;
  readonly hostname: string;
  readonly origin: string;
  readonly protocol: string;
  readonly href: string;
  toString(): string;
}
