/** All Redis keys in one place so prefixes never collide. */
export const keys = {
  session: (id: string) => `session:${id}`,
  events: (id: string) => `events:${id}`,
  cache: (name: string) => `cache:${name}`,
  option: (id: string) => `option:${id}`,
  rate: (group: string, subject: string, window: number) => `rate:${group}:${subject}:${window}`,
  spend: (day: string) => `spend:${day}`,
  semaphore: (name: string) => `sem:${name}`,
  bucket: (provider: string) => `bucket:${provider}`,
  prefetchLock: (hash: string) => `prefetch:${hash}`,
  runLock: (sessionId: string) => `runlock:${sessionId}`,
};
