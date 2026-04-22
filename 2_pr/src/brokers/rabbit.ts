import amqp, { Channel, ChannelModel } from "amqplib";
import { APP_CONFIG } from "../config.js";
import { BrokerMessage, BrokerPublisher, BrokerSubscriber, ConsumeHandler } from "../types.js";

const buildChannel = async (): Promise<{ connection: ChannelModel; channel: Channel }> => {
  const connection = await amqp.connect(APP_CONFIG.rabbitUrl);
  const channel = await connection.createChannel();
  await channel.assertQueue(APP_CONFIG.rabbitQueue, { durable: false });
  return { connection, channel };
};

export const createRabbitPublisher = async (): Promise<BrokerPublisher> => {
  const { connection, channel } = await buildChannel();

  return {
    async publish(message: BrokerMessage) {
      const body = Buffer.from(JSON.stringify(message), "utf8");
      channel.sendToQueue(APP_CONFIG.rabbitQueue, body, { persistent: false });
    },
    async close() {
      await channel.close();
      await connection.close();
    }
  };
};

export const createRabbitSubscriber = async (): Promise<BrokerSubscriber> => {
  const { connection, channel } = await buildChannel();
  let consumerTag: string | null = null;

  return {
    async start(handler: ConsumeHandler) {
      const consumeResult = await channel.consume(
        APP_CONFIG.rabbitQueue,
        async (msg) => {
          if (!msg) {
            return;
          }

          try {
            const payload = JSON.parse(msg.content.toString("utf8")) as BrokerMessage;
            await handler(payload);
            channel.ack(msg);
          } catch {
            channel.nack(msg, false, false);
          }
        },
        { noAck: false }
      );

      consumerTag = consumeResult.consumerTag;
    },
    async stop() {
      if (consumerTag) {
        await channel.cancel(consumerTag);
      }
      await channel.close();
      await connection.close();
    },
    async getBacklog() {
      const queue = await channel.checkQueue(APP_CONFIG.rabbitQueue);
      return queue.messageCount;
    }
  };
};
