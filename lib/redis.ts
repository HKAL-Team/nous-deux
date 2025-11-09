import { createClient } from 'redis';
declare global {
  var _redisClient: ReturnType<typeof createClient> | undefined;
}
const isSkippingConnection = process.env.SKIP_REDIS_CONNECTION === 'true';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let redisClient: ReturnType<typeof createClient>;
if (isSkippingConnection) {
  console.log('Redis connection skipped during build.');
  redisClient = {
    connect: () => Promise.resolve(), 
    on: () => {}, 
    get: async () => null, 
    set: async () => {}, 
  } as unknown as ReturnType<typeof createClient>;
} else {
  redisClient = global._redisClient ?? createClient({ url: redisUrl });
  if (!global._redisClient) {
    redisClient.on('error', (err) => console.error('Redis Client Error', err));
    redisClient.connect().catch(console.error);
    global._redisClient = redisClient;
  }
}

export default redisClient;