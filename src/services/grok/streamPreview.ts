/** Publish accumulated stream text at most once per interval. flush always publishes the latest text. */
export function createPreviewGate(options: {
  minIntervalMs: number;
  publish: (text: string) => Promise<void> | void;
  now?: () => number;
}): {
  push: (text: string) => Promise<void>;
  flush: () => Promise<void>;
} {
  const now = options.now ?? (() => Date.now());
  const interval = Math.max(1_000, options.minIntervalMs);
  let latest = "";
  let lastAt = 0;
  let opened = false;

  const publish = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    latest = text;
    lastAt = now();
    opened = true;
    try {
      await options.publish(text);
    } catch {
      // A preview edit must not discard the accumulated answer.
    }
  };

  return {
    async push(text) {
      latest = text;
      const time = now();
      if (opened && time - lastAt < interval) return;
      await publish(text);
    },
    async flush() {
      if (!latest.trim()) return;
      await publish(latest);
    },
  };
}
