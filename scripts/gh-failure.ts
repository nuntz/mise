/**
 * Whether a failed `gh` call is worth trying again. GitHub's API sometimes answers a call with a
 * server error (`HTTP 500 (https://api.github.com/…)` on stderr) while the run is fine, and the same
 * call succeeds a moment later; anything else (auth, a missing run, gh itself) will fail again.
 */
export function ghFailure(stderr: string): "transient" | "final" {
  return /\bHTTP 5\d\d\b/.test(stderr) ? "transient" : "final";
}
