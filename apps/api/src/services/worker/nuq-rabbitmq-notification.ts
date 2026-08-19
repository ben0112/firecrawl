type JobEndStatus = "completed" | "failed";

export function clearRabbitMqSenderIfCurrent<T>(
  current: T | null,
  closing: T,
): T | null {
  return current === closing ? null : current;
}

interface NotificationError {
  name: string;
  code?: string;
  message: string;
}

export interface RabbitMqJobEndNotificationOptions {
  queueName: string;
  listenChannelId: string;
  jobId: string;
  status: JobEndStatus;
  startSender: () => Promise<void>;
  send: () => void;
  resetSender: () => void;
  warn: (details: {
    module: "nuq/rabbitmq";
    queueName: string;
    jobId: string;
    status: JobEndStatus;
    attempts: 2;
    error: NotificationError;
  }) => void;
}

function notificationError(error: unknown): NotificationError {
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  const message = String(
    value?.message || error || "RabbitMQ notification failed",
  ).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1[REDACTED]@");
  return {
    name: String(value?.name || "Error").slice(0, 100),
    ...(value?.code ? { code: String(value.code).slice(0, 100) } : {}),
    message: message.slice(0, 300),
  };
}

export async function sendRabbitMqJobEndBestEffort(
  options: RabbitMqJobEndNotificationOptions,
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await options.startSender();
      options.send();
      return true;
    } catch (error) {
      lastError = error;
      try {
        options.resetSender();
      } catch {}
    }
  }

  try {
    options.warn({
      module: "nuq/rabbitmq",
      queueName: options.queueName,
      jobId: options.jobId,
      status: options.status,
      attempts: 2,
      error: notificationError(lastError),
    });
  } catch {}
  return false;
}
