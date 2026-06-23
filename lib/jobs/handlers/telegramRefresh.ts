import type { JobPayload } from "@/lib/jobs/types";
import { handlerNotImplemented, type JobHandler } from "./types";

type TelegramPayload = Extract<JobPayload, { jobType: "telegram.refresh" }>;

export const handleTelegramRefresh: JobHandler<TelegramPayload> = async (payload) => {
  return handlerNotImplemented(
    payload.jobType,
    "telegram.refresh is registered but deferred until a safe snapshot-only refresh path exists; P8C does not send Telegram messages",
  );
};
