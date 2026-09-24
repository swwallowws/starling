import { ApiError } from "./api";
import type { Rendered, Settings } from "./types";

export function createRenderer(
  fetchRender: (takeId: number, s: Settings) => Promise<Rendered>,
  onResult: (r: Rendered, s: Settings) => void,
  onTuningError: (msg: string) => void,
) {
  let seq = 0;
  let good: Settings | null = null;
  let first: Settings | null = null;
  const request = (takeId: number, s: Settings) => {
    first ??= s;
    const mine = ++seq;
    fetchRender(takeId, s).then(
      (r) => {
        if (mine !== seq) return;
        good = s;
        onResult(r, s);
      },
      (e) => {
        if (mine !== seq) return;
        if (e instanceof ApiError && e.status === 400 && e.message.startsWith("tuning") && good) {
          onTuningError(e.message);
          request(takeId, { ...s, tuning_name: good.tuning_name, tuning_scl: good.tuning_scl });
        }
      },
    );
  };
  /** The settings of the last successful render (or the first request, before any). */
  return { request, lastGood: (): Settings => good ?? first! };
}
