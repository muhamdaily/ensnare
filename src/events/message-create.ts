import { GatewayDispatchEvents, type RESTAPIMessageReference, RESTJSONErrorCodes, type APIMessage, MessageReferenceType, MessageType } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import { addToEnsureMsgDeleteQueue, getDmChannelCache, getGuildInfo, getIsAlreadyModerating, getSubscribedChannelCache, setDmChannelCache, setIsAlreadyModerating, setSubscribedChannelCache, unsetIsAlreadyModerating } from "../utils/cache";
import { CUSTOM_EMOJI_ID, HAS_MESSAGE_INTENT } from "../utils/constants";
import { ensnareUserDMMessage, ensnareWarningMessage, logActionMessage } from "../utils/messages";
import { DiscordAPIError } from "@discordjs/rest";
import { styleText } from "node:util";
import { getDiscordDate } from "../utils/tools";

// limit to only send 120 per minute to avoid being blocked by Discord (or at least not get ratelimited too much)  
let dms = {
    count: 0,
    reset: Date.now() + 60_000
}

const handler: EventHandler<GatewayDispatchEvents.MessageCreate> = {
    event: GatewayDispatchEvents.MessageCreate,
    handler: async ({ data: message, api, applicationId, redis, db }) => {
        if (!message.guild_id) return;

        // if a user used a slash command, attribute it to the user instead of ignoring as its a bot msg
        if (message.interaction_metadata && message.author.id !== applicationId) {
            return await onMessage({
                userId: message.interaction_metadata.user.id,
                channelId: message.channel_id,
                guildId: message.guild_id,
                messageId: message.id,
                msgType: message.type,
                userRoles: message.interaction?.member?.roles || []
            }, api, db, redis);
        }

        // if it's a normal message, only trigger if it's not a bot (to avoid spam as we trust actual bots more)
        if (!message.author.bot && !message.author.system) {
            if (ignoredMessageTypes.has(message.type)) return;
            return await onMessage({
                userId: message.author.id,
                channelId: message.channel_id,
                guildId: message.guild_id,
                messageId: message.id,
                msgType: message.type,
                userRoles: message.member?.roles || []
            }, api, db, redis);
        }

        // if it's a bot message, still get the proxy to properly subscribe and avoid seeing the spam
        if (process.env.HAS_PROXY_WS && redis && message.guild_id) {
            const result = await db.getConfigWithChannels(message.guild_id);
            if (!result) return;
            const { config, channels } = result;
            if (!config || !config.action) return;
            if (channels.some(c => c.channel_id === message.channel_id)) return;
            const ids = channels.map(c => c.channel_id);
            setSubscribedChannelCache(message.guild_id, ids.length > 0 ? ids : ["none"], redis);
        }
    }
};

const onMessage = async (
    { userId, channelId, guildId, messageId, threadId, msgType, userRoles }: { userId: string, channelId: string, guildId: string, messageId?: string, threadId?: string, msgType?: MessageType, userRoles: string[] },
    api: API | API2,
    db: typeof import("../utils/db"),
    redis?: Bun.RedisClient
) => {
    try {
        if (!process.env.HAS_PROXY_WS && redis) {
            const channels = await getSubscribedChannelCache(guildId, redis)
            if (channels && !channels.includes(channelId)) return;
        }

        const result = await db.getConfigWithChannels(guildId);
        if (!result) return;

        const { config, channels } = result;
        if (!config || !config.action) return;

        const matchedChannel = channels.find(c => c.channel_id === channelId);
        if (!matchedChannel) {
            if (redis) {
                const ids = channels.map(c => c.channel_id);
                setSubscribedChannelCache(guildId, ids.length > 0 ? ids : ["none"], redis);
            }
            return;
        }

        // try to delete the triggering message (if experiment enabled), fallback to reaction, fallback to just logging
        let deleteMessageStatus = null as null | Promise<boolean | null>;
        let emojiReact = null as null | Promise<any>
        if (messageId) {
            if (HAS_MESSAGE_INTENT && config.experiments.includes("ensure-msg-delete") && config.action !== 'disabled') {
                // try to delete it so we know if it actually has permission to delete rest of server's ones
                // and also so user doesn't see it in any capacity (ie shows them that its working and they can't post here)
                deleteMessageStatus = api.channels.deleteMessage(
                    channelId,
                    messageId,
                    { reason: "Triggered ensnare" }
                ).then(() => true)
                    .catch((err) => {
                        if (err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.UnknownMessage)) {
                            console.log(styleText("dim", `Triggering message already deleted: ${err}`));
                            return true;
                        } else if (err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.MissingAccess || err.code === RESTJSONErrorCodes.MissingPermissions)) {
                            console.log(styleText("dim", `Failed to delete triggering message, likely due to missing permissions: ${err}`));
                            return false;
                        } else {
                            console.log(`Failed to delete triggering message: ${err}`);
                            return false;
                        }
                    });
            } else {
                // just for the fun of it to acknowledge it saw the message
                emojiReact = api.channels.addMessageReaction(
                    channelId,
                    messageId,
                    `ensnare:${CUSTOM_EMOJI_ID}`,
                    // this really doesn’t matter, so lets not have it get stuck in ratelimit queue if bot gets enough usage
                    { signal: AbortSignal.timeout(1000) }
                ).catch(() => null);
            }
        }

        if (config.action === 'disabled') return;

        // avoid double moderation if many messages are sent (easy if many ensnare channels)
        if (redis) {
            if (await getIsAlreadyModerating(guildId, userId, redis))
                return console.log(styleText("dim", "Already moderating user, skipping..."));
            setIsAlreadyModerating(guildId, userId, redis);
        }

        const preActionPromise = Bun.sleep(2000)
        const preActionAbort = new AbortController();

        let forwardPromise = null as null | Promise<any>;
        if (HAS_MESSAGE_INTENT && config.experiments.includes("forward-message") && config.log_channel_id && messageId && msgType !== undefined) {
            // intentionally not awaited as in theory we can do DM and this at same time (and avoid extra wait-time)
            const forwardableMsgTypes = [MessageType.Default, MessageType.Reply, MessageType.ChatInputCommand, MessageType.ContextMenuCommand];
            if (forwardableMsgTypes.includes(msgType)) {
                forwardPromise = api.channels.createMessage(config.log_channel_id, {
                    message_reference: {
                        type: MessageReferenceType.Forward,
                        channel_id: channelId,
                        message_id: messageId,
                        guild_id: guildId,
                    }
                }, { signal: preActionAbort.signal }).catch(err => {
                    const discordApiError = err instanceof DiscordAPIError ? err : null;
                    if (discordApiError && discordApiError.code === 160009 /** undocumented error code */) {
                        api.channels.createMessage(config.log_channel_id!, {
                            content: `Would forward https://discord.com/channels/${guildId}/${channelId}/${messageId}, but the bot doesn't have permission to Read Message History in that channel.`,
                            allowed_mentions: {},
                        }).catch(err => console.log(styleText("dim", `Failed to send message about missing permissions to forward to log channel: ${err}`)));
                        console.log(styleText("dim", `Failed to forward message to log channel ${config.action}: ${err}`));
                    } else if (discordApiError && discordApiError.message.includes("MESSAGE_REFERENCE_UNKNOWN_MESSAGE")) {
                        console.log(styleText("dim", `Failed to forward message to log channel ${config.action}: ${err.toString().replace("\n", "; ")}`));
                    } else if (`${err}` === "AbortError: The operation was aborted." || `${err}` === "Error: Request aborted manually") {
                        console.log(styleText("dim", `Failed to forward message to log channel: ${err}`));
                    } else if (discordApiError && (discordApiError.code === RESTJSONErrorCodes.MissingAccess || discordApiError.code === RESTJSONErrorCodes.MissingPermissions)) {
                        console.log(styleText("dim", `Failed to forward message to log channel: ${err}`));
                    } else {
                        console.log(`Failed to forward message to log channel: ${err}`);
                    }
                });
            } else { } // maybe handle other ones and say the type or smth
        }

        let timeoutPromise = null as null | Promise<any>;
        if (config.experiments.includes("timeout-first")) {
            // intentionally not awaited as in theory we can do DM and this at same time (and avoid extra wait-time)
            timeoutPromise = api.guilds.editMember(guildId, userId,
                { communication_disabled_until: new Date(Date.now() + 3_600_000).toISOString() },
                { reason: `Triggered ensnare -> timeout for 1hr before ${config.action}`, signal: preActionAbort.signal }
            ).then(() => Bun.sleep(50))
                .catch(err => {
                    if (err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.MissingPermissions)) {
                        console.log(styleText("dim", `Failed to timeout user before ${config.action}: ${err}`));
                    } else {
                        console.log(`Failed to timeout user before ${config.action}: ${err}`);
                    }
                });
        }

        const customMessages = await db.getEnsnareMessages(guildId);

        // should DM user first before banning so that discord has less reason to block it
        let permissionSkip = false as "owner" | "admin" | false;
        const dmMessage: Promise<APIMessage | null> = (async () => {
            try {
                const guild = await getGuildInfo(api, guildId, preActionAbort.signal, redis).catch(() => null);
                permissionSkip = guild?.ownerId === userId ? "owner" : guild?.adminRoles?.some(role => userRoles.includes(role)) ? "admin" : false;
                if (config.experiments.includes("no-dm")) return null;

                // check our simple dm ratelimit
                if (!permissionSkip && dms.count >= 120) {
                    if (Date.now() < dms.reset) {
                        console.log(styleText("dim", "Self imposed DM ratelimit reached, skipping DM to user"));
                        return null;
                    } else {
                        dms.count = 0;
                        dms.reset = Date.now() + 60_000;
                    }
                }
                dms.count++;

                let dmChannel = redis && await getDmChannelCache(userId, redis);
                if (!dmChannel) {
                    ({ id: dmChannel } = await api.users.createDM(userId, { signal: preActionAbort.signal }));
                    if (redis) setDmChannelCache(userId, dmChannel, redis);
                }
                const reinviteCode = config.experiments.includes("reinvite") && await db.getReinvite(guildId);
                const link = `https://discord.com/channels/${guildId}/${channelId}/${matchedChannel.msg_id || messageId || ""}`;
                const dmContent = ensnareUserDMMessage(
                    config.action,
                    guild?.name ?? guildId!,
                    guild?.isDiscoverable ? `https://discord.com/servers/${guildId}` : undefined,
                    link,
                    reinviteCode ? `https://discord.gg/${reinviteCode}` : null,
                    permissionSkip !== false,
                    customMessages?.dm_message
                );
                return await api.channels.createMessage(dmChannel, dmContent, { signal: preActionAbort.signal });
            } catch (err) {
                /* Ignore DM errors (user has DMs closed, etc.) */
                if (`${err}` === "AbortError: The operation was aborted." || `${err}` === "Error: Request aborted manually") {
                    console.log(styleText("dim", `Failed to send DM to user: ${err}`));
                } else if (err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser || err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds)) {
                    console.log(styleText("dim", `Failed to send DM to user: ${err}`));
                } else {
                    console.log(`Failed to send DM to user: ${err}`)
                }
            }
            return null;
        })();

        // we prob will win forwarding before the ban's delete comes into action, so no point delaying the ban to wait for msg to create (and not the biggest deal if it fails)
        // also if timeout fails, we don't want to wait too long before banning
        await Promise.race([preActionPromise, Promise.all([dmMessage, timeoutPromise, forwardPromise].filter(p => !!p))]);

        let failed: boolean | "permissions" | "admin" | "unban" = false;
        if (!permissionSkip) try {
            // normally 1hr, but with the option only do last 15min
            const deleteMessageSeconds = config.experiments.includes("only-recent-delete")
                ? 900 // 15min
                : 3600; // 1hr

            if (config.action === 'ban') {
                // Ban: permanent ban, delete last 1 hour of messages
                await api.guilds.banUser(
                    guildId,
                    userId,
                    { delete_message_seconds: deleteMessageSeconds },
                    { reason: "Triggered ensnare -> ban" }
                );
                Bun.sleep(150).then(() => preActionAbort.abort());
            } else if (config.action === 'softban' || config.action === 'kick') {
                // Kick: kick but via ban/unban, delete last 1 hour of messages
                await api.guilds.banUser(
                    guildId,
                    userId,
                    { delete_message_seconds: deleteMessageSeconds },
                    { reason: "Triggered ensnare -> softban (kick) 1/2" }
                );
                Bun.sleep(150).then(() => preActionAbort.abort());
                try {
                    await Bun.sleep(250);
                    await api.guilds.unbanUser(
                        guildId,
                        userId,
                        { reason: "Triggered ensnare -> softban (kick) 2/2" }
                    );
                } catch (err) {
                    // maybe discord hasn't banned yet and is throwing unknown ban, so try again after a short wait
                    if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownBan) {
                        console.log(styleText("dim", `Failed to unban user after ban: ${err}`));
                        // If its still throwing unknown ban, then the user is likely already unbanned by some external force
                    } else {
                        console.log(`Failed to unban user after ban: ${err}`);
                        failed = "unban";
                    }
                }

                // https://github.com/discord/discord-api-docs/issues/8360
                // sometimes banning doesn't actually remove messages - maybe doing it again later helps
                // (async () => {
                //     await Bun.sleep(10_000)
                //     // put it here instead of above because they may join back too early and get kicked again which isn't any good
                //     await api.guilds.unbanUser(
                //         guildId,
                //         userId,
                //         { reason: "Triggered ensnare -> softban (kick) 2/4" }
                //     );

                //     await api.guilds.banUser(
                //         guildId,
                //         userId,
                //         { delete_message_seconds: deleteMessageSeconds },
                //         { reason: "Triggered ensnare -> softban (kick) 3/4", signal: AbortSignal.timeout(25_000) }
                //     );
                //     await api.guilds.unbanUser(
                //         guildId,
                //         userId,
                //         { reason: "Triggered ensnare -> softban (kick) 4/4", signal: AbortSignal.timeout(25_000) }
                //     );
                // })().catch(err =>
                //     console.log(`Failed to double softban user (probably not an issue): ${err}`)
                // );
            } else {
                console.error("Unknown action in ensnare config:", config.action);
                failed = true;
            }
        } catch (err) {
            if (err instanceof DiscordAPIError && (err.code == RESTJSONErrorCodes.MissingPermissions)) {
                console.log(styleText("dim", `Failed to ${config.action} user: ${err}`));
                failed = "permissions";
            } else {
                console.log(`Failed to ${config.action} user: ${err}`);
                failed = true;
            }
        } else {
            // server owner cannot be banned/kicked by anyone
            failed = "admin";
        };
        if (!failed && !permissionSkip) {
            await db.logModerateEvent(guildId, userId, matchedChannel.channel_id);
            redis?.publish("moderate_event", "+1");

            // if it took >30sec from actual message invocation to now, add a log telling us
            // its prob ratelimit, but something important to keep track of if it gets bad
            const id = messageId || threadId || null;
            if (id) {
                const diffSeconds = Math.floor((Date.now() - getDiscordDate(id)) / 1000);
                if (diffSeconds > 30) {
                    console.log(styleText("reset", `Moderated user in ${diffSeconds}s from ${messageId ? "message" : "thread"} creation`));
                }
            }
            if (!preActionAbort.signal.aborted) preActionAbort.abort();
        }

        // if they rejoin server, let them be punished again
        if (redis) unsetIsAlreadyModerating(guildId, userId, redis);

        const moderatedCount = await db.getModeratedCount(guildId, channels.length > 1 ? matchedChannel.channel_id : null);


        async function logMessage() {
            if (!matchedChannel) return;
            try {
                // const reply = (messageId && channelId === matchedChannel.channel_id) ? {
                //     message_id: messageId,
                //     fail_if_not_exists: false,
                // } satisfies RESTAPIMessageReference : undefined;
                const reply = undefined as RESTAPIMessageReference | undefined;

                if (config.log_channel_id && !failed && !permissionSkip) {
                    await api.channels.createMessage(config.log_channel_id, {
                        ...logActionMessage(userId, matchedChannel.channel_id, config.action, customMessages?.log_message, moderatedCount),
                        allowed_mentions: { users: [userId] },
                    });
                } else if (permissionSkip) {
                    await api.channels.createMessage(config.log_channel_id || matchedChannel.channel_id, {
                        content: `⚠️ User <@${userId}> triggered the ensnare, but they are ${permissionSkip === "owner" ? "the **server owner** so I cannot" : "a **server admin** so I won’t"} ${config.action} them.\n-# In anycase **ensure my role is higher** than people’s highest role and that I have **ban members** permission so I can ${config.action} for actual cases.`,
                        allowed_mentions: { users: [userId] },
                        message_reference: reply
                    });
                } else if (failed === "unban" && config.action === "softban") {
                    await api.channels.createMessage(config.log_channel_id || matchedChannel.channel_id, {
                        content: `⚠️ User <@${userId}> triggered the ensnare, but I failed to **fully** softban them.\n-# They may still be banned but you can manually unban them in server settings.`,
                        allowed_mentions: { users: [userId] },
                        message_reference: reply
                    });
                    await emojiReact;
                } else if (failed === "permissions") {
                    await api.channels.createMessage(config.log_channel_id || matchedChannel.channel_id, {
                        content: `⚠️ User <@${userId}> triggered the ensnare, but I **failed** to ${config.action} them.\n-# Please check my permissions to **ensure my role is higher** than their highest role and that I have **ban members** permission.`,
                        allowed_mentions: { users: [userId] },
                        message_reference: reply
                    });
                    await emojiReact;
                } else if (failed) {
                    await api.channels.createMessage(config.log_channel_id || matchedChannel.channel_id, {
                        content: `⚠️ User <@${userId}> triggered the ensnare, but I **failed** to ${config.action} them.\n-# This could be due to a transient Discord issue, or something unexpected. Please check my permissions in any case.`,
                        allowed_mentions: { users: [userId] },
                        message_reference: reply
                    });
                    await emojiReact;
                }
            } catch (err) {
                // somewhat chance the channel is deleted or the bot lost perms to send messages there
                if (err instanceof DiscordAPIError) {
                    if (err.code == RESTJSONErrorCodes.UnknownChannel && config.log_channel_id) {
                        await db.unsetLogChannel(guildId, config.log_channel_id);
                    } else if (err.code == RESTJSONErrorCodes.MissingAccess || err.code == RESTJSONErrorCodes.MissingPermissions) {
                        console.log(styleText("dim", `Failed to send log message (MessageCreate handler): ${err}`));
                    } else {
                        console.log(`Failed to send log message (MessageCreate handler): ${err}`);
                    }
                } else console.log(`Failed to send log message (MessageCreate handler): ${err}`);
            }
        }

        async function updateWarning() {
            if (!matchedChannel) return;
            if (matchedChannel.msg_id && !config.experiments.includes("no-warning-msg")) try {
                await api.channels.editMessage(
                    matchedChannel.channel_id,
                    matchedChannel.msg_id,
                    ensnareWarningMessage(moderatedCount, config.action, customMessages?.warning_message)
                );
            } catch (err) {
                const discordError = err instanceof DiscordAPIError ? err : null;
                if (discordError && discordError.code == RESTJSONErrorCodes.UnknownMessage) {
                    console.log(styleText("dim", `Failed to update ensnare message (after banning): ${err}`));
                    await db.unsetEnsnareMsg(guildId, matchedChannel.msg_id!);
                } else if (discordError && (discordError.code == RESTJSONErrorCodes.MissingPermissions || discordError.code == RESTJSONErrorCodes.MissingAccess)) {
                    console.log(styleText("dim", `Failed to update ensnare message (after banning): ${err}`));
                    await db.unsetEnsnareMsg(guildId, matchedChannel.msg_id!);
                } else console.log(`Failed to update ensnare message (after banning): ${err}`);
            }
        }

        async function addToDeleteQueue() {
            if (!matchedChannel) return;
            const succeededToDelete = deleteMessageStatus ? await deleteMessageStatus : null;
            if (succeededToDelete === false) {
                try {
                    // send error msg to log channel saying it doesnt have perms to delete messages
                    await api.channels.createMessage(config.log_channel_id || matchedChannel.channel_id, {
                        content: `The bot failed to manually delete the [triggering message](https://discord.com/channels/${guildId}/${matchedChannel.channel_id}/${messageId ?? ""}), likely because it doesn't have permission to Manage Messages in that channel. Please check my permissions or disable the "Ensure Message Delete" experiment.`
                            + `\n-# This message may be deleted properly by discord, however this experiment is to ensure there isn't anything left over by them.`,
                        allowed_mentions: {},
                    });
                } catch (err) {
                    console.log(`Failed to send message about missing permissions to delete messages to log channel: ${err}`);
                }
            } else if (!failed && succeededToDelete === true && HAS_MESSAGE_INTENT) {
                addToEnsureMsgDeleteQueue(userId, guildId, redis);
            }
        }

        await Promise.all([logMessage(), updateWarning(), addToDeleteQueue()]);
    } catch (err) {
        console.error(`Error with MessageCreate handler: ${err}`);
    }
};

// mostly not their decision to post here as a system notification
// mainly the ones that are send on behalf of user to the system channel
const ignoredMessageTypes = new Set([
    MessageType.UserJoin,
    MessageType.ChannelPinnedMessage,
    MessageType.GuildBoost,
    MessageType.GuildBoostTier1,
    MessageType.GuildBoostTier2,
    MessageType.GuildBoostTier3,
    MessageType.ChannelFollowAdd,
    MessageType.PollResult,
    MessageType.PurchaseNotification,
    MessageType.AutoModerationAction,
]);


export default handler;
