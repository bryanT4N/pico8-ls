// A request handler that throws makes the server answer with an InternalError, and vscode-languageclient 7 then shows
// "A request has failed. See the output for more information." (client.js:2020-2025, 2662). The user should only get
// an empty answer, so the error goes to the log instead.
// fallback: what to answer when handler throws, from the same params.
export function guarded<P, R>(what: string, fallback: (params: P) => R, handler: (params: P) => R): (params: P) => R {
  return params => {
    try {
      return handler(params);
    } catch (e) {
      console.error(`Failed to ${what}`, e);
      return fallback(params);
    }
  };
}
