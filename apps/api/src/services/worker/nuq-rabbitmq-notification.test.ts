import { describe, expect, it, vi } from "vitest";

import {
  clearRabbitMqSenderIfCurrent,
  sendRabbitMqJobEndBestEffort,
} from "./nuq-rabbitmq-notification";

describe("sendRabbitMqJobEndBestEffort", () => {
  it("reconnects once after ECONNRESET and resolves", async () => {
    const attempts: string[] = [];
    let sendCount = 0;

    const result = await sendRabbitMqJobEndBestEffort({
      queueName: "nuq.queue_scrape",
      listenChannelId: "listener",
      jobId: "job-1",
      status: "completed",
      startSender: async () => {
        attempts.push("start");
      },
      send: () => {
        attempts.push("send");
        sendCount += 1;
        if (sendCount === 1) {
          throw Object.assign(new Error("write ECONNRESET"), {
            code: "ECONNRESET",
          });
        }
      },
      resetSender: () => {
        attempts.push("reset");
      },
      warn: () => {
        attempts.push("warn");
      },
    });

    expect(result).toBe(true);
    expect(attempts).toEqual(["start", "send", "reset", "start", "send"]);
  });

  it("keeps the durable result when both sends fail", async () => {
    const warn = vi.fn();
    let resets = 0;

    const result = await sendRabbitMqJobEndBestEffort({
      queueName: "nuq.queue_scrape",
      listenChannelId: "listener",
      jobId: "job-2",
      status: "failed",
      startSender: async () => undefined,
      send: () => {
        throw Object.assign(new Error("connection closed"), {
          code: "ECONNRESET",
        });
      },
      resetSender: () => {
        resets += 1;
      },
      warn,
    });

    expect(result).toBe(false);
    expect(resets).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith({
      module: "nuq/rabbitmq",
      queueName: "nuq.queue_scrape",
      jobId: "job-2",
      status: "failed",
      attempts: 2,
      error: {
        name: "Error",
        code: "ECONNRESET",
        message: "connection closed",
      },
    });
  });

  it("does not reject when sender cleanup or warning logging fails", async () => {
    let sendCount = 0;

    await expect(
      sendRabbitMqJobEndBestEffort({
        queueName: "nuq.queue_scrape",
        listenChannelId: "listener",
        jobId: "job-3",
        status: "completed",
        startSender: async () => undefined,
        send: () => {
          sendCount += 1;
          throw new Error("connection closed");
        },
        resetSender: () => {
          throw new Error("cleanup failed");
        },
        warn: () => {
          throw new Error("logger failed");
        },
      }),
    ).resolves.toBe(false);
    expect(sendCount).toBe(2);
  });

  it("redacts credentials from the final error message", async () => {
    const warn = vi.fn();

    await sendRabbitMqJobEndBestEffort({
      queueName: "nuq.queue_scrape",
      listenChannelId: "listener",
      jobId: "job-4",
      status: "failed",
      startSender: async () => undefined,
      send: () => {
        throw new Error(
          "connect ECONNRESET amqp://secret-user:secret-pass@rabbitmq:5672/vhost",
        );
      },
      resetSender: () => undefined,
      warn,
    });

    const details = warn.mock.calls[0][0];
    expect(details.error.message).not.toContain("secret-user");
    expect(details.error.message).not.toContain("secret-pass");
    expect(details.error.message).toContain("amqp://[REDACTED]@rabbitmq:5672");
  });
});

describe("clearRabbitMqSenderIfCurrent", () => {
  it("does not clear a replacement sender when an old connection closes late", () => {
    const oldSender = { id: "old" };
    const replacement = { id: "replacement" };

    expect(clearRabbitMqSenderIfCurrent(replacement, oldSender)).toBe(
      replacement,
    );
    expect(clearRabbitMqSenderIfCurrent(oldSender, oldSender)).toBeNull();
  });
});
