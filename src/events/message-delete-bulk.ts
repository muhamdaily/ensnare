import { GatewayDispatchEvents } from "discord-api-types/v10";
import type { EventHandler } from "./events";

const handler: EventHandler<GatewayDispatchEvents.MessageDeleteBulk> = {
    event: GatewayDispatchEvents.MessageDeleteBulk,
    handler: async ({ data: messageBatch, api, applicationId, redis, db }) => {
        if (!messageBatch.guild_id) return;
        try {
            await db.unsetEnsnareMsgs(messageBatch.guild_id, messageBatch.ids);
        } catch (err) {
            console.error(`Error with MessageDeleteBulk handler: ${err}`);
        }
    }
};

export default handler;
