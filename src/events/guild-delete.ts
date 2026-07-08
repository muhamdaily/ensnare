import { GatewayDispatchEvents } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import { invalidateGuildInfoCache, removeGuildSubscribedChannelCache } from "../utils/cache";

const handler: EventHandler<GatewayDispatchEvents.GuildDelete> = {
    event: GatewayDispatchEvents.GuildDelete,
    handler: async ({ data: guild, api, applicationId, redis, db }) => {
        try {
            // The bot didnt actually leave the guild, discord itself merely is having some issues there
            if (guild.unavailable === true) return;
            await db.deleteConfig(guild.id);
            invalidateGuildInfoCache(guild.id, redis);
            if (redis) removeGuildSubscribedChannelCache(guild.id, redis);
            redis?.publish("guild_count", "-1");
        } catch (err) {
            console.error(`Failed to delete ensnare config for guild ${guild.id}:`, err);
        }
    }
};

export default handler;
