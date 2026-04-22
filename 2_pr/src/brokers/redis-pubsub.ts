import { createClient } from "redis";
import { APP_CONFIG } from "../config.js";
import { BrokerMessage, BrokerPublisher, BrokerSubscriber, ConsumeHandler } from "../types.js";

const connectClient = async () => {
  const client = createClient({ url: APP_CONFIG.redisUrl });
  await client.connect();
  return client;
};

export const createRedisPublisher = async (): Promise<BrokerPublisher> => {
  const publisher = await connectClient();

  return {
    async publish(message: BrokerMessage) {
      await publisher.publish(APP_CONFIG.redisChannel, JSON.stringify(message));
    },
    async close() {
      await publisher.quit();
    }
  };
};

export const createRedisSubscriber = async (): Promise<BrokerSubscriber> => {
  const subscriber = await connectClient();
  let isSubscribed = false;

  return {
    async start(handler: ConsumeHandler) {
      isSubscribed = true;
      await subscriber.subscribe(APP_CONFIG.redisChannel, async (raw) => {
        try {
          const payload = JSON.parse(raw) as BrokerMessage;
          await handler(payload);
        } catch {
          // Ignored intentionally: malformed messages are counted as errors in consumer.
        }
      });
    },
    async stop() {
      if (isSubscribed) {
        await subscriber.unsubscribe(APP_CONFIG.redisChannel);
      }
      await subscriber.quit();
    },
    async getBacklog() {
      // Redis Pub/Sub has no durable backlog by design.
      return null;
    }
  };
};
