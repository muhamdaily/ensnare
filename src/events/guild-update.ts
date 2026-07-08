import { GatewayDispatchEvents } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import { setGuildInfoCache } from "../utils/cache";

const handler: EventHandler<GatewayDispatchEvents.GuildUpdate> = {
    event: GatewayDispatchEvents.GuildUpdate,
    handler: async ({ data: guild, api, applicationId, redis, db }) => {
        setGuildInfoCache(guild.id, guild, redis);
    }
};

export default handler;
