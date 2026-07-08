import { ButtonStyle, ChannelType, ComponentType, GatewayDispatchEvents, InteractionType, MessageFlags, PermissionFlagsBits, RESTJSONErrorCodes, SelectMenuDefaultValueType, TextInputStyle, type APIInteractionDataResolvedChannel, type APIModalInteractionResponseCallbackData, type APISelectMenuOption, type RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import type { EnsnareConfig } from "../utils/db";
import { ensnareWarningMessage, defaultEnsnareWarningMessage, defaultEnsnareUserDMMessage, defaultLogActionMessage, ensnareUserDMMessage, defaultEnsnareUserDMMessageReinvitePart } from "../utils/messages";
import { channelWarmerExperiment, randomChannelNameExperiment } from "../cron/experiments";
import getBadWords from "../utils/bad-words.macro" with { type: "macro" };
import { CUSTOM_EMOJI, CUSTOM_EMOJI_ID, HAS_MESSAGE_INTENT } from "../utils/constants";
import { getDmChannelCache, getGuildInfo, removeFromDeleteMessageCache, setDmChannelCache, setSubscribedChannelCache } from "../utils/cache";
import { DiscordAPIError } from "@discordjs/rest";
import { styleText } from "node:util";
import { getDiscordDate, hasPermission } from "../utils/tools";
import type { CreateInteractionResponseOptions } from "@discordjs/core";

const badWords = getBadWords() as any as Awaited<ReturnType<typeof getBadWords>>;
const containsBadWord = (text: string): string | null => {
    const inputWords = text.toLowerCase().replace(/[^a-z0-9]/gi, ' ').split(/\W+/).filter(Boolean);
    return inputWords.find(word => badWords.includes(word)) || null;
}


const handler: EventHandler<GatewayDispatchEvents.InteractionCreate> = {
    event: GatewayDispatchEvents.InteractionCreate,
    handler: async ({ data: interaction, api, applicationId, redis, db }) => {
        const guildId = interaction.guild_id;
        const userId = interaction.member?.user.id || interaction.user?.id;
        if (!userId) return console.error("No user ID found in interaction, skipping????");
        const userContextHash = Bun.hash(guildId + applicationId + userId).toString(16);

        try {
            // slash command handler: show modal
            if (guildId && interaction.type === InteractionType.ApplicationCommand && interaction.data.name === "ensnare") {
                const result = await db.getConfigWithChannels(guildId);
                const config: EnsnareConfig = result?.config ?? {
                    guild_id: guildId,
                    log_channel_id: null,
                    action: 'softban',
                    experiments: []
                };
                const channels = result?.channels ?? [];

                // some experiments we should only show to "power users" that may need it after seeing issues & not just clicking everything
                const hasEnsnareHistory = await db.getGuildHasEnsnareHistory(guildId);

                const manyEnsnares = config.experiments.includes("many-ensnares");
                const experimentOptions = ([
                    HAS_MESSAGE_INTENT && { label: "Forward Message", value: "forward-message", description: "Forward the triggered message to the log channel", default: config.experiments.includes("forward-message") },
                    { label: "⭐ Reinvite", value: "reinvite", description: "In the DM message give an invite code to rejoin (recommended)", default: config.experiments.includes("reinvite") },
                    { label: "Timeout First", value: "timeout-first", description: "Timeout users (for 1hr) to limit their activity on rejoin", default: config.experiments.includes("timeout-first") },
                    // { label: "Timeout for Typing", value: "timeout-for-typing", description: "Timeout users (for 10sec) who are typing in the ensnare channel", default: config.experiments.includes("timeout-for-typing") },
                    { label: "Channel Warmer", value: "channel-warmer", description: "Keep the ensnare channel active (every day)", default: config.experiments.includes("channel-warmer") },
                    { label: "Random Channel Name", value: "random-channel-name", description: "Randomize the ensnare channel name (every day)", default: config.experiments.includes("random-channel-name") },
                    { label: "⭐ Only More Recent Delete", value: "only-recent-delete", description: "Only delete last 15min of messages (instead of 1hr)", default: config.experiments.includes("only-recent-delete") },
                    { label: "No Warning Msg", value: "no-warning-msg", description: "Don't include the warning message in the #ensnare channel (deletes current if already present)", default: config.experiments.includes("no-warning-msg") },
                    { label: "No DM", value: "no-dm", description: "Don't DM the user that they triggered the ensnare", default: config.experiments.includes("no-dm") },
                    { label: "Random Channel Name (Chaos)", value: "random-channel-name-chaos", description: "Randomise the ensnare channel name with random characters (every day)", default: config.experiments.includes("random-channel-name-chaos") },
                    hasEnsnareHistory && { label: "⚠️ Recreate Channel", value: "recreate-channel", description: "Remake the ensnare channel (every day) - experiment may be removed & messages aren't preserved", default: config.experiments.includes("recreate-channel") },
                    { label: "⭐ Many Ensnares", value: "many-ensnares", description: "Ability to create multiple ensnare channels - must submit modal and re-run /ensnare to set them", default: config.experiments.includes("many-ensnares") },
                    HAS_MESSAGE_INTENT && hasEnsnareHistory && { label: "⚠️ Ensure Message Deletion (only use if needed)", value: "ensure-msg-delete", description: "Search & delete leftover messages from moderated users 2min after moderation.", default: config.experiments.includes("ensure-msg-delete") },
                ] satisfies (APISelectMenuOption | false)[]).filter(e => !!e);

                const modal: APIModalInteractionResponseCallbackData = {
                    title: "Ensnare",
                    custom_id: `ensnare_config_modal:${userContextHash}`,
                    components: [
                        {
                            type: ComponentType.Label,
                            label: `Ensnare Channel${manyEnsnares ? "s" : ''}`,
                            description: `Any message sent in ${manyEnsnares ? "these channels" : "this channel"} will cause the author to be kicked/banned from server`,
                            component: {
                                type: ComponentType.ChannelSelect,
                                custom_id: "ensnare_channel",
                                min_values: 1,
                                max_values: manyEnsnares ? 10 : 1,
                                placeholder: "#ensnare",
                                channel_types: [ChannelType.GuildText, ChannelType.GuildVoice],
                                default_values: channels.length > 0 ? channels.slice(0, 10).map(c => ({ id: c.channel_id, type: SelectMenuDefaultValueType.Channel })) : [],
                                required: true,
                            }
                        },
                        {
                            type: ComponentType.Label,
                            label: "Log Channel",
                            description: "The channel to log events (ie kicks/bans that the bot actioned)",
                            component: {
                                type: ComponentType.ChannelSelect,
                                custom_id: "log_channel",
                                min_values: 0,
                                max_values: 1,
                                placeholder: "#mod-log",
                                channel_types: [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread],
                                default_values: config.log_channel_id ? [{ id: config.log_channel_id, type: SelectMenuDefaultValueType.Channel }] : [],
                                required: false,
                            }
                        },
                        {
                            type: ComponentType.Label,
                            label: "Action",
                            description: "What should the bot do to message author?",
                            component: {
                                type: ComponentType.RadioGroup,
                                custom_id: "ensnare_action",
                                options: [
                                    { label: "Softban (kick)", value: "softban", description: "Bans & unbans to delete last 1hr of messages", default: config.action === "softban" || (config.action as any) === "kick" || !config.action },
                                    { label: "Ban", value: "ban", description: "Permanently bans the user to also delete last 1hr of messages", default: config.action === "ban" },
                                    { label: "Disabled", value: "disabled", /*description: "Don’t do anything",*/ default: config.action === "disabled" }
                                ],
                                required: true,
                            }
                        },
                        {
                            type: ComponentType.Label,
                            label: "Experiments",
                            // description: "Some optional experimental features to try out",
                            component: {
                                type: ComponentType.StringSelect,
                                custom_id: "ensnare_experiments",
                                placeholder: "Select experiments to enable",
                                options: experimentOptions,
                                min_values: 0,
                                max_values: experimentOptions.length,
                                required: false,
                            }
                        }
                    ]
                };
                await api.interactions.createModal(interaction.id, interaction.token, modal);
                return;
            }

            // modal submit handler: update config from modal values
            else if (guildId && interaction.type === InteractionType.ModalSubmit && interaction.data.custom_id === `ensnare_config_modal:${userContextHash}`) {
                const newConfig: EnsnareConfig = {
                    guild_id: guildId,
                    log_channel_id: null,
                    action: 'softban',
                    experiments: []
                }
                let selectedChannelIds: string[] = [];

                let deferredPromise = false as false | Promise<true>;
                const deferTimeout = setTimeout(() => {
                    deferredPromise = api.interactions.defer(interaction.id, interaction.token).then(() => true);
                }, 2500 - (Date.now() - getDiscordDate(interaction.id)));

                const interactionReply = async (body: CreateInteractionResponseOptions) => {
                    if (await deferredPromise) {
                        return api.interactions.editReply(applicationId, interaction.token, body);
                    }
                    clearTimeout(deferTimeout);
                    return api.interactions.reply(interaction.id, interaction.token, body);
                };

                for (const label of interaction.data.components) {
                    if (label.type !== ComponentType.Label) continue;
                    const c = (label).component ?? label;
                    if (!c) continue;

                    if (c.type === ComponentType.ChannelSelect) {
                        if (c.custom_id === "ensnare_channel" && Array.isArray(c.values) && c.values.length > 0) {
                            selectedChannelIds.push(...c.values);
                        }
                        if (c.custom_id === "log_channel" && Array.isArray(c.values) && c.values.length > 0) {
                            newConfig.log_channel_id = c.values[0]!;
                        }
                    }
                    if (c.type === ComponentType.RadioGroup) {
                        if (c.custom_id === "ensnare_action" && c.value) {
                            if (["kick", "ban", "disabled"].includes(c.value)) newConfig.action = c.value as any;
                        }
                    }
                    if (c.type === ComponentType.StringSelect) {
                        if (c.custom_id === "ensnare_experiments" && Array.isArray(c.values)) {
                            for (const val of c.values) {
                                if (["no-warning-msg", "no-dm", "random-channel-name", "random-channel-name-chaos", "channel-warmer", "recreate-channel", "forward-message", "reinvite", "timeout-first", "only-recent-delete", "many-ensnares", "ensure-msg-delete"].includes(val)) {
                                    newConfig.experiments.push(val as any);
                                }
                            }
                        }
                    }
                }

                if (selectedChannelIds.length === 0) {
                    await interactionReply({
                        content: "At least one ensnare channel is required! No changes have been made.",
                        allowed_mentions: {},
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                // if not using many ensnares experiment, then just use first
                if (selectedChannelIds.length > 1 && !newConfig.experiments.includes("many-ensnares")) {
                    selectedChannelIds = selectedChannelIds.slice(0, 1);
                }

                const prev = await db.getConfigWithChannels(guildId);
                const prevConfig = prev?.config ?? null;
                const prevChannels = prev?.channels ?? [];
                const prevChannelIds = new Set(prevChannels.map(c => c.channel_id));
                const addedChannels = selectedChannelIds.filter(id => !prevChannelIds.has(id));
                const removedChannels = prevChannels.filter(c => !selectedChannelIds.includes(c.channel_id));
                const logChanged = newConfig.log_channel_id !== prevConfig?.log_channel_id;

                // pretty reasonable requests to ensure user can even do said actions
                const permissionIssues = validateConfigPermissions(
                    newConfig,
                    selectedChannelIds,
                    interaction.data.resolved?.channels,
                    interaction.member?.permissions,
                    interaction.app_permissions,
                );
                if (permissionIssues.length > 0) {
                    await interactionReply({
                        content: (permissionIssues.length > 1 ? permissionIssues.map(e => `- ${e}`).join("\n") : permissionIssues[0])
                            + "\n-# No settings have been changed.",
                        allowed_mentions: {},
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                // if ensnare channel changed or current ensnare msg is invalid, create new ensnare message
                // otherwise try to edit it with latest data
                // but if either fail, then let user know its broken sadly
                const msgIds = new Map<string, string | null>();
                if (!newConfig.experiments.includes("no-warning-msg")) {
                    const customMessages = await db.getEnsnareMessages(guildId);

                    for (const channelId of selectedChannelIds) {
                        const count = await db.getModeratedCount(guildId, selectedChannelIds.length > 1 ? channelId : null);
                        const messageBody = ensnareWarningMessage(count, newConfig.action, customMessages?.warning_message);
                        const prevMatch = prevChannels.find(c => c.channel_id === channelId) ?? null;
                        try {
                            if (!prevMatch?.msg_id) {
                                const msg = await api.channels.createMessage(channelId, messageBody);
                                msgIds.set(channelId, msg.id);
                            } else {
                                try {
                                    await api.channels.editMessage(channelId, prevMatch.msg_id, messageBody);
                                    msgIds.set(channelId, prevMatch.msg_id);
                                } catch {
                                    const msg = await api.channels.createMessage(channelId, messageBody);
                                    msgIds.set(channelId, msg.id);
                                }
                            }
                        } catch (err) {
                            if (err instanceof DiscordAPIError && (err.code == RESTJSONErrorCodes.MissingAccess || err.code == RESTJSONErrorCodes.MissingPermissions)) {
                                console.log(styleText("dim", `Error creating/editing ensnare message (interaction handler): ${err}`));
                                await interactionReply({
                                    content: `I don’t have access to the ensnare channel <#${channelId}>. Please make sure I have access to that channel and try again (both View Channel and Send Messages permissions).\n-# No settings have been changed.`,
                                    allowed_mentions: {},
                                    flags: MessageFlags.Ephemeral,
                                });
                            } else {
                                console.log(`Error creating/editing ensnare message (interaction handler): ${err}`);
                                await interactionReply({
                                    content: `There was a problem setting up the ensnare channel <#${channelId}>. Please check my permissions and try again.\n-# No settings have been changed.`,
                                    allowed_mentions: {},
                                    flags: MessageFlags.Ephemeral,
                                });
                            }
                            for (const [cid, mid] of msgIds) {
                                // only delete the message if it was created in this setup attempt (ie keep valid ones)
                                if (prevChannels.find(c => c.channel_id === cid)?.msg_id === mid) continue;
                                if (mid) api.channels.deleteMessage(cid, mid, { reason: "Cleaning up ensnare messages after setup failure" }).catch(() => null);
                            }
                            return;
                        }
                    }

                    for (const ch of removedChannels) {
                        if (ch.msg_id) api.channels.deleteMessage(ch.channel_id, ch.msg_id).catch(() => null);
                    }
                } else {
                    // they didn’t want ensnare msg, so delete old ones if exists
                    for (const channel of prevChannels) {
                        if (channel.msg_id) api.channels.deleteMessage(channel.channel_id, channel.msg_id).catch(() => null);
                    }
                }

                if (logChanged && newConfig.log_channel_id) {
                    try {
                        await api.channels.createMessage(newConfig.log_channel_id, {
                            content: `Ensnare is set up in ${selectedChannelIds.map(id => `<#${id}>`).join(", ")}! This current channel will log ensnare events.`,
                            allowed_mentions: {},
                        });
                    } catch (err) {
                        // clean up just created ensnare message if log channel fails (because user might think it's fully set up otherwise)
                        for (const [cid, mid] of msgIds) {
                            if (mid) api.channels.deleteMessage(cid, mid, { reason: "Cleaning up ensnare messages after log channel setup failure" }).catch(() => null);
                        }

                        if (err instanceof DiscordAPIError && (err.code == RESTJSONErrorCodes.MissingAccess || err.code == RESTJSONErrorCodes.MissingPermissions)) {
                            console.log(styleText('dim', `Error sending test message to log channel (interaction handler): ${err}`));
                            await interactionReply({
                                content: `I don't have access to the log channel <#${newConfig.log_channel_id}>. Please make sure I have access to that channel and try again (both View Channel and Send Messages permissions).\n-# No settings have been changed.`,
                                allowed_mentions: {},
                                flags: MessageFlags.Ephemeral,
                            });
                        } else {
                            console.log(`Error sending test message to log channel (interaction handler): ${err}`);
                            await interactionReply({
                                content: `There was a problem sending test message to the log channel <#${newConfig.log_channel_id}>. Please check my permissions and try again.\n-# No settings have been changed.`,
                                flags: MessageFlags.Ephemeral,
                                allowed_mentions: {},
                            });
                        }
                        return;
                    }
                }

                let inviteCode = null as string | null;
                if (newConfig.experiments.includes("reinvite") && (!prevConfig?.experiments.includes("reinvite") || addedChannels.length > 0)) {
                    const inviteChannelId = selectedChannelIds[0]!;
                    try {
                        const invite = await api.channels.createInvite(inviteChannelId, {
                            max_age: 0,
                            max_uses: 0,
                            unique: false,
                        }, {
                            reason: "Creating invite for reinvite experiment",
                            signal: AbortSignal.timeout(20_000),
                        });
                        inviteCode = invite.code;
                    } catch (err) {
                        for (const [cid, mid] of msgIds) {
                            if (mid) api.channels.deleteMessage(cid, mid, { reason: "Cleaning up ensnare messages after reinvite experiment failure" }).catch(() => null);
                        }

                        const errorCode = err instanceof DiscordAPIError ? err.code : null;
                        if (errorCode === RESTJSONErrorCodes.MaximumNumberOfInvitesReached) {
                            console.log(styleText("dim", `Error creating invite for reinvite experiment: ${err}`));
                            await interactionReply({
                                content: `There are too many invites in your server to make one for <#${inviteChannelId}>. Please delete some existing invites and try again.\n-# No settings have been changed.`,
                                allowed_mentions: {},
                                flags: MessageFlags.Ephemeral,
                            });
                        } else if (errorCode === RESTJSONErrorCodes.MissingAccess || errorCode === RESTJSONErrorCodes.MissingPermissions) {
                            console.log(styleText("dim", `Error creating invite for reinvite experiment: ${err}`));
                            await interactionReply({
                                content: `I don't have permission to create invites in the ensnare channel <#${inviteChannelId}>. Please make sure I have the Create Invite permission in that channel and try again.\n-# No settings have been changed.`,
                                allowed_mentions: {},
                                flags: MessageFlags.Ephemeral,
                            });
                        } else {
                            console.log(`Error fetching invite for reinvite experiment: ${err}`);
                            await interactionReply({
                                content: `There was a problem fetching the invite code for the "Reinvite" experiment. Please check my permissions and try again.\n-# No settings have been changed.`,
                                allowed_mentions: {},
                                flags: MessageFlags.Ephemeral,
                            });
                        }
                        return;
                    }
                    const messages = await db.getEnsnareMessages(guildId);
                    if (messages.dm_message && !messages.dm_message?.includes(defaultEnsnareUserDMMessageReinvitePart)) {
                        const newDmMessage = messages.dm_message + defaultEnsnareUserDMMessageReinvitePart;
                        await db.setEnsnareMessages(guildId, {
                            ...messages,
                            dm_message: newDmMessage,
                        });
                    }
                } else if (!newConfig.experiments.includes("reinvite") && prevConfig?.experiments.includes("reinvite")) {
                    await db.setReinvite(guildId, false);
                    const messages = await db.getEnsnareMessages(guildId);
                    if (messages.dm_message?.includes(defaultEnsnareUserDMMessageReinvitePart)) {
                        const newDmMessage = messages.dm_message.replace(defaultEnsnareUserDMMessageReinvitePart, "");
                        await db.setEnsnareMessages(guildId, {
                            ...messages,
                            dm_message: newDmMessage,
                        });
                    }
                }

                await db.setConfig({
                    guild_id: guildId,
                    log_channel_id: newConfig.log_channel_id,
                    action: newConfig.action,
                    experiments: newConfig.experiments,
                });
                await db.setEnsnareChannels(guildId, selectedChannelIds.map(id => ({
                    channel_id: id,
                    msg_id: msgIds.get(id) ?? null,
                })));
                if (inviteCode) await db.setReinvite(guildId, inviteCode);


                // best to be 100% accurate (ie edit from at right time where there is technically another channel chosen)
                const allChannels = await db.getChannels(guildId);
                await interactionReply({
                    content: `Ensnare config updated!\n-# - Channels: ${allChannels.map(c => `<#${c.channel_id}>`).join(", ")}\n-# - Log Channel: ${newConfig.log_channel_id ? `<#${newConfig.log_channel_id}>` : '*(Not set)*'}\n-# - Action: **${newConfig.action}**${newConfig.experiments.length > 0 ? `\n-# - Experiments: ${newConfig.experiments.map(e => `\`${e}\``).join(", ")}` : ''}`,
                    allowed_mentions: {},
                });
                if (redis) setSubscribedChannelCache(guildId, allChannels.map(c => c.channel_id), redis);

                // clean up old warning messages from channels that were removed
                for (const ch of removedChannels) {
                    if (ch.msg_id) {
                        api.channels.deleteMessage(ch.channel_id, ch.msg_id, { reason: "Ensnare channel changed, so cleaning up old ensnare message" }).catch(() => null);
                    }
                }

                // run experiments that were just enabled immediately
                if (!prevConfig?.experiments.includes("channel-warmer") && newConfig.experiments.includes("channel-warmer")) {
                    for (const id of selectedChannelIds) {
                        try {
                            await channelWarmerExperiment(api, guildId, id)
                        } catch (err) {
                            api.channels.createMessage(newConfig.log_channel_id || id, {
                                content: `There was a problem sending a message to the <#${id}> channel for the "Channel Warmer" experiment. Please check my permissions.`,
                                allowed_mentions: {},
                            }).catch(() => null);
                        }
                    }
                }
                if (
                    (!prevConfig?.experiments.includes("random-channel-name") && newConfig.experiments.includes("random-channel-name"))
                    || (!prevConfig?.experiments.includes("random-channel-name-chaos") && newConfig.experiments.includes("random-channel-name-chaos"))
                ) {
                    for (const id of selectedChannelIds) {
                        try {
                            await randomChannelNameExperiment(api, guildId, id, newConfig.experiments.includes("random-channel-name-chaos"))
                        } catch (err) {
                            api.channels.createMessage(newConfig.log_channel_id || id, {
                                content: `There was a problem updating the <#${id}> channel for the "Random Channel Name" experiment. Please check my permissions.`,
                                allowed_mentions: {},
                            }).catch(() => null);
                        }
                    }
                }
                return;
            }

            function getDmMessage(config: EnsnareConfig | null, guild: Awaited<ReturnType<typeof getGuildInfo>> | null): string {
                let msg = defaultEnsnareUserDMMessage;
                if (config?.experiments?.includes("reinvite")) {
                    msg += defaultEnsnareUserDMMessageReinvitePart;
                }
                if (guild?.isDiscoverable) {
                    msg = msg.replace(" **{{server:name}}** ", " **{{server:name:linked}}** ");
                }
                return msg;
            }
            // slash command handler: show modal
            if (guildId && interaction.type === InteractionType.ApplicationCommand && interaction.data.name === "ensnare-messages") {
                const [messages, config, guild] = await Promise.all([
                    db.getEnsnareMessages(guildId),
                    db.getConfig(guildId),
                    getGuildInfo(api, guildId, AbortSignal.timeout(500), redis).catch(() => null)
                ]);

                const modal: APIModalInteractionResponseCallbackData = {
                    title: "Ensnare's Messages",
                    custom_id: `ensnare_messages_modal:${userContextHash}`,
                    components: [
                        {
                            type: ComponentType.TextDisplay,
                            content: "Set custom messages for the ensnare bot:\n" +
                                "-# - You can use the variables in your messages shown in template/default text - [see all](https://ensnare.muhamdaily.dev/docs/configuration#message-variables)\n" +
                                "-# - If you leave the textbox empty, then it'll reset to default\n" +
                                "-# - Make sure to keep the messages clear and informative!"
                        },
                        {
                            type: ComponentType.Label,
                            label: "Ensnare Warning",
                            description: "This is the message shown in the ensnare channel",
                            component: {
                                type: ComponentType.TextInput,
                                custom_id: "ensnare_warning",
                                style: TextInputStyle.Paragraph,
                                min_length: 10,
                                max_length: 1500,
                                required: false,
                                value: messages?.warning_message || defaultEnsnareWarningMessage,
                            },
                        },
                        {
                            type: ComponentType.Label,
                            label: "Ensnare DM Message",
                            description: "This is the message sent to users via DM when they trigger the ensnare",
                            component: {
                                type: ComponentType.TextInput,
                                custom_id: "ensnare_dm_message",
                                style: TextInputStyle.Paragraph,
                                min_length: 10,
                                max_length: 1000,
                                required: false,
                                value: messages?.dm_message || getDmMessage(config, guild),
                            },
                        },
                        {
                            type: ComponentType.Label,
                            label: "Log Message",
                            description: "This is the message shown in the log channel",
                            component: {
                                type: ComponentType.TextInput,
                                custom_id: "log_message",
                                style: TextInputStyle.Paragraph,
                                min_length: 10,
                                max_length: 500,
                                required: false,
                                value: messages?.log_message || defaultLogActionMessage,
                            },
                        },
                        {
                            type: ComponentType.Label,
                            label: "Reset All Messages",
                            description: "Nothing you changed here will persist. This will reset all messages to their default values.",
                            component: {
                                type: ComponentType.Checkbox,
                                custom_id: "reset_messages",
                                default: false
                            },
                        },
                    ]
                };
                await api.interactions.createModal(interaction.id, interaction.token, modal);
                return;
            }

            // modal submit handler: update config from modal values
            else if (guildId && interaction.type === InteractionType.ModalSubmit && interaction.data.custom_id === `ensnare_messages_modal:${userContextHash}`) {
                const [config, channels, guild] = await Promise.all([
                    db.getConfig(guildId),
                    db.getChannels(guildId),
                    getGuildInfo(api, guildId, AbortSignal.timeout(500), redis).catch(() => null)
                ]);

                const newMessages: Awaited<ReturnType<typeof db.getEnsnareMessages>> = {
                    dm_message: null,
                    warning_message: null,
                    log_message: null,
                }
                let reset = false;

                for (const label of interaction.data.components) {
                    if (label.type !== ComponentType.Label) continue;
                    const c = (label).component ?? label;
                    if (!c || reset) continue;

                    if (c.type === ComponentType.TextInput) {
                        if (c.custom_id === "ensnare_warning" && c.value.length) {
                            if (c.value !== defaultEnsnareWarningMessage) newMessages.warning_message = c.value;
                        }
                        if (c.custom_id === "ensnare_dm_message" && c.value.length) {
                            if (c.value !== defaultEnsnareUserDMMessage && c.value !== getDmMessage(config, guild)) newMessages.dm_message = c.value;
                        }
                        if (c.custom_id === "log_message" && c.value.length) {
                            if (c.value !== defaultLogActionMessage) newMessages.log_message = c.value;
                        };
                    }
                    if (c.type === ComponentType.Checkbox) {
                        if (c.custom_id === "reset_messages" && c.value) {
                            reset = true;
                            newMessages.dm_message = null;
                            newMessages.warning_message = null;
                            newMessages.log_message = null;
                        }
                    }
                }

                // test that the messages are "safe" with rudimentary checks for bad words
                const warningMsgSus = newMessages.warning_message ? containsBadWord(newMessages.warning_message) : false;
                const dmMsgSus = newMessages.dm_message ? containsBadWord(newMessages.dm_message) : false;
                const logMsgSus = newMessages.log_message ? containsBadWord(newMessages.log_message) : false;
                if (warningMsgSus || dmMsgSus || logMsgSus) {
                    await api.interactions.reply(interaction.id, interaction.token, {
                        content: `One or more of your messages contain words that are not allowed on Discord. Please remove any inappropriate language and try again.\n-# No changes have been saved.`,
                        allowed_mentions: {},
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                // ensnare log should contain {{user:mention}}, so its not fully a free for all
                const logMsgMustIncludeOneOf = ["{{user:mention}}", "{{user:ping}}", "{{user:id}}"];
                if (newMessages.log_message && !logMsgMustIncludeOneOf.some(variable => newMessages.log_message!.includes(variable))) {
                    await api.interactions.reply(interaction.id, interaction.token, {
                        content: `The log message must contain the variable \`{{user:mention}}\` to show the user that triggered the ensnare. Please include that variable in your log message and try again.\n-# No changes have been saved.`,
                        allowed_mentions: {},
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                await api.interactions.reply(interaction.id, interaction.token, {
                    flags: MessageFlags.IsComponentsV2,
                    components: [
                        {
                            type: ComponentType.TextDisplay,
                            content: "**Ensnare messages updated!**",
                        },
                        {
                            type: ComponentType.TextDisplay,
                            content: newMessages.warning_message ? "Warning Message" : "Warning Message: *(Using default)*",
                        },
                        newMessages.warning_message && {
                            type: ComponentType.Container,
                            components: [
                                {
                                    type: ComponentType.TextDisplay,
                                    content: newMessages.warning_message
                                }
                            ],
                        },
                        {
                            type: ComponentType.TextDisplay,
                            content: newMessages.dm_message ? "DM Message" : "DM Message: *(Using default)*",
                        },
                        newMessages.dm_message && {
                            type: ComponentType.Container,
                            components: [
                                {
                                    type: ComponentType.TextDisplay,
                                    content: newMessages.dm_message
                                }
                            ],
                        },
                        {
                            type: ComponentType.TextDisplay,
                            content: newMessages.log_message ? "Log Message" : "Log Message: *(Using default)*",
                        },
                        newMessages.log_message && {
                            type: ComponentType.Container,
                            components: [
                                {
                                    type: ComponentType.TextDisplay,
                                    content: newMessages.log_message
                                }
                            ],
                        },
                    ].filter(e => !!e),

                    allowed_mentions: {},
                } as RESTPostAPIChannelMessageJSONBody);

                const existingMessages = await db.getEnsnareMessages(guildId);
                await db.setEnsnareMessages(guildId, newMessages);

                if (!config?.experiments.includes("no-warning-msg")) {
                    const msgIds = new Map<string, string | null>();
                    await Promise.allSettled(channels.map(async (msgChannel) => {
                        const guildModeratedCount = await db.getModeratedCount(guildId, channels.length > 1 ? msgChannel.channel_id : null);
                        const messageBody = ensnareWarningMessage(guildModeratedCount, config?.action || 'softban', newMessages.warning_message);

                        try {
                            if (!msgChannel.msg_id) {
                                const msg = await api.channels.createMessage(msgChannel.channel_id, messageBody);
                                msgIds.set(msgChannel.channel_id, msg.id);
                            } else {
                                try {
                                    await api.channels.editMessage(msgChannel.channel_id, msgChannel.msg_id, messageBody);
                                } catch {
                                    const msg = await api.channels.createMessage(msgChannel.channel_id, messageBody);
                                    msgIds.set(msgChannel.channel_id, msg.id);
                                }
                            }
                        } catch (err) {
                            if (err instanceof DiscordAPIError && (err.code == RESTJSONErrorCodes.MissingAccess || err.code == RESTJSONErrorCodes.MissingPermissions)) {
                                console.log(styleText('dim', `Error updating ensnare warning message (interaction handler): ${err}`));
                                await api.interactions.followUp(interaction.id, interaction.token, {
                                    content: `I don't have access to the ensnare channel <#${msgChannel.channel_id}> to update the warning message. Please make sure I have access to that channel and try again (both View Channel and Send Messages permissions).\n-# Your custom messages have still been saved though.`,
                                    allowed_mentions: {},
                                    flags: MessageFlags.Ephemeral,
                                });
                            } else {
                                console.log(`Error updating ensnare warning message (interaction handler): ${err}`);
                                await api.interactions.followUp(interaction.id, interaction.token, {
                                    content: `There was a problem updating the ensnare warning message in <#${msgChannel.channel_id}>. Please check my permissions and your custom message.\n-# Your custom messages have still been saved though.`,
                                    allowed_mentions: {},
                                    flags: MessageFlags.Ephemeral,
                                });
                            }
                            return;
                        }
                    }));
                    if (msgIds.size > 0) {
                        await db.setEnsnareChannels(guildId, channels.map(c => ({
                            channel_id: c.channel_id,
                            msg_id: msgIds.get(c.channel_id) ?? c.msg_id,
                        })));
                    }
                }

                if (newMessages.dm_message && existingMessages?.dm_message !== newMessages.dm_message) {
                    const timeout = AbortSignal.timeout(10_000);
                    const userId = (interaction.user || interaction.member?.user)?.id;
                    if (userId) {
                        try {
                            const server = await getGuildInfo(api, guildId, timeout, redis);
                            let dmChannel = redis && await getDmChannelCache(userId, redis);
                            if (!dmChannel) {
                                ({ id: dmChannel } = await api.users.createDM(userId, { signal: timeout }));
                                if (redis) setDmChannelCache(userId, dmChannel, redis);
                            }
                            const reinviteCode = config?.experiments.includes("reinvite") && await db.getReinvite(guildId);
                            await api.channels.createMessage(
                                dmChannel,
                                ensnareUserDMMessage(
                                    config?.action || "softban",
                                    server.name ?? guildId!,
                                    server.isDiscoverable ? `https://discord.com/servers/${guildId}` : undefined,
                                    `https://discord.com/channels/${guildId}/${channels[0]?.channel_id || ""}/${channels[0]?.msg_id || ""}`,
                                    reinviteCode ? `https://discord.gg/${reinviteCode}` : null,
                                    false,
                                    newMessages.dm_message,
                                    true
                                ),
                                { signal: timeout }
                            );
                        } catch (err) {
                            if (err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser || err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds)) {
                                console.log(styleText("dim", `Error sending example DM message: ${err}`));
                            } else {
                                console.log(`Error sending example DM message: ${err}`);
                            }
                        }
                    }
                }

                return;
            }

            // dm command to show stats
            else if (interaction.type === InteractionType.ApplicationCommand && interaction.data.name === "stats") {
                const { totalGuilds, totalModerated } = await db.getStats();
                const userId = (interaction.user || interaction.member?.user)?.id
                const userModeratedCount = userId ? await db.getUserModeratedCount(userId) : 0;

                await api.interactions.reply(interaction.id, interaction.token, {
                    flags: MessageFlags.IsComponentsV2,
                    allowed_mentions: {},
                    components: [
                        {
                            type: ComponentType.Container,
                            components: [
                                {
                                    type: ComponentType.TextDisplay,
                                    content: [
                                        `## ${CUSTOM_EMOJI} Ensnare Bot Statistics ${CUSTOM_EMOJI}`,
                                        "",
                                        `Total servers: \`${totalGuilds.toLocaleString()}\``,
                                        `Total moderations: \`${totalModerated.toLocaleString()}\``,
                                        `Times you've been #ensnare'd: \`${(userModeratedCount || 0).toLocaleString()}\``,
                                    ].join("\n"),
                                },
                                {
                                    type: ComponentType.TextDisplay,
                                    content: "-# Thank you for using [Ensnare Bot](https://ensnare.muhamdaily.dev) to keep your servers safe from unwanted bots!"
                                },
                                {
                                    type: ComponentType.ActionRow,
                                    components: [
                                        {
                                            type: ComponentType.Button,
                                            url: `https://discord.com/oauth2/authorize?client_id=${interaction.application_id}`,
                                            style: ButtonStyle.Link,
                                            label: "Invite Bot",
                                            emoji: { name: "ensnare", id: CUSTOM_EMOJI_ID }
                                        },
                                        {
                                            type: ComponentType.Button,
                                            url: "https://discord.gg/wYZa4Fpwfy",
                                            style: ButtonStyle.Link,
                                            label: "Support Server"
                                        },
                                        {
                                            type: ComponentType.Button,
                                            url: "https://muhamdaily.dev",
                                            style: ButtonStyle.Link,
                                            label: "muhamdaily.dev"
                                        },
                                    ]
                                },
                            ],
                        },
                    ]
                });
            }

            // button to show guild stats
            else if (interaction.type === InteractionType.MessageComponent && interaction.data.custom_id === "moderated_count_button") {
                const [guildStats, channels, { totalGuilds, totalModerated }] = await Promise.all([
                    db.getGuildStats(guildId!),
                    db.getChannels(guildId!),
                    db.getStats(),
                ]);

                const guildStatsMapping: Record<string, number> = {};
                const channelLessStats = guildStats.find(s => s.channel_id === null)?.moderatedCount;
                for (const channel of channels) {
                    const stat = guildStats.find(s => s.channel_id === channel.channel_id);
                    guildStatsMapping[channel.channel_id] = stat ? stat.moderatedCount : 0;
                }
                const totalInGuild = guildStats.reduce((acc, stat) => acc + stat.moderatedCount, 0);

                await api.interactions.reply(interaction.id, interaction.token, {
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    allowed_mentions: {},
                    components: [
                        {
                            type: ComponentType.Container,
                            components: [
                                {
                                    type: ComponentType.TextDisplay,
                                    content: `## ${CUSTOM_EMOJI} Ensnare Statistics ${CUSTOM_EMOJI}`,
                                },
                                {
                                    type: ComponentType.TextDisplay,
                                    content: [
                                        "**Server Stats:**",
                                        `Total moderated in this server: \`${totalInGuild.toLocaleString()}\``,
                                        ...(Object.keys(guildStatsMapping).length === 1 ? ""
                                            : channels.map(chan => `-# - <#${chan.channel_id}>: \`${guildStatsMapping[chan.channel_id]?.toLocaleString() || 0}\``)),
                                        channelLessStats && channelLessStats > 0 && guildStats.length > 1
                                            ? `-# - *Removed ensnares*: \`${channelLessStats.toLocaleString()}\`` : ""
                                    ].join("\n"),
                                },
                                {
                                    type: ComponentType.TextDisplay,
                                    content: [
                                        "**Global Stats:**",
                                        `Total servers: \`${totalGuilds.toLocaleString()}\``,
                                        `Total moderations: \`${totalModerated.toLocaleString()}\``,
                                    ].join("\n"),
                                },
                                {
                                    type: ComponentType.TextDisplay,
                                    content: "-# Thank you for using [Ensnare Bot](https://ensnare.muhamdaily.dev) to keep your servers safe from unwanted bots!"
                                },
                                {
                                    type: ComponentType.ActionRow,
                                    components: [
                                        {
                                            type: ComponentType.Button,
                                            url: `https://discord.com/oauth2/authorize?client_id=${interaction.application_id}`,
                                            style: ButtonStyle.Link,
                                            label: "Invite Bot",
                                            emoji: { name: "ensnare", id: CUSTOM_EMOJI_ID }
                                        },
                                        {
                                            type: ComponentType.Button,
                                            url: "https://ensnare.muhamdaily.dev/docs",
                                            style: ButtonStyle.Link,
                                            label: "Documentation"
                                        },
                                        {
                                            type: ComponentType.Button,
                                            url: "https://ensnare.muhamdaily.dev/#stats",
                                            style: ButtonStyle.Link,
                                            label: "Live Stats"
                                        },
                                    ]
                                },
                            ],
                        },
                    ]
                });
            }

            // into welcome command to allow early deleting
            else if (guildId && interaction.type === InteractionType.MessageComponent && interaction.data.custom_id === "delete_intro_message") {
                if (!interaction.member?.permissions || !hasPermission(BigInt(interaction.member.permissions), PermissionFlagsBits.ManageMessages)) {
                    await api.interactions.reply(interaction.id, interaction.token, {
                        content: "You need the Manage Messages permission to delete this message.",
                        allowed_mentions: {},
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                await api.channels.deleteMessage(interaction.message.channel_id, interaction.message.id).catch(() => null);
                await api.interactions.deferMessageUpdate(interaction.id, interaction.token).catch(() => null);
                if (redis) removeFromDeleteMessageCache(interaction.message.channel_id, interaction.message.id, redis).catch(() => null);
            }

            // easy unban button
            else if (guildId && interaction.type === InteractionType.MessageComponent && interaction.data.custom_id.startsWith("unban:")) {
                if (!interaction.member?.permissions || !hasPermission(BigInt(interaction.member.permissions), PermissionFlagsBits.BanMembers)) {
                    await api.interactions.reply(interaction.id, interaction.token, {
                        content: "You need the Ban Members permission to unban this user.",
                        allowed_mentions: {},
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }
                if (!interaction.app_permissions || !hasPermission(BigInt(interaction.app_permissions), PermissionFlagsBits.BanMembers)) {
                    await api.interactions.reply(interaction.id, interaction.token, {
                        content: "I need the Ban Members permission to unban this user.",
                        allowed_mentions: {},
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                const messageAge = Date.now() - new Date(interaction.message.timestamp).getTime();
                if (messageAge > 24 * 60 * 60 * 1000) {
                    await api.interactions.reply(interaction.id, interaction.token, {
                        content: "This unban button has expired because it's been more than 24 hours since the user was banned. Please use the regular bans tab in member settings.",
                        allowed_mentions: {},
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                const userIdToUnban = interaction.data.custom_id.slice("unban:".length);

                try {
                    await api.guilds.unbanUser(guildId, userIdToUnban, { reason: `Unbanned by @${interaction.member.user.username} using the unban button in the ensnare log message` });
                } catch (err) {
                    if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownBan) {
                        await api.interactions.reply(interaction.id, interaction.token, {
                            content: "This user is not currently banned.",
                            allowed_mentions: {},
                            flags: MessageFlags.Ephemeral,
                        });
                        return;
                    }

                    console.log(`Error unbanning user: ${err}`);
                    await api.interactions.reply(interaction.id, interaction.token, {
                        content: "There was a problem unbanning the user. Please check my permissions and try again.",
                        allowed_mentions: {},
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                await api.interactions.reply(interaction.id, interaction.token, {
                    content: `User <@${userIdToUnban}> has been unbanned by <@${interaction.member.user.id}>!`,
                    allowed_mentions: {},
                });
            }

            return;
        } catch (err) {
            let interactionInfo = "";
            if (interaction.type === InteractionType.ApplicationCommand) {
                interactionInfo = `/${interaction.data.name}`;
            } else if (interaction.type === InteractionType.MessageComponent) {
                interactionInfo = `msg ${interaction.data.custom_id.split(":")[0]}`;
            } else if (interaction.type === InteractionType.ModalSubmit) {
                interactionInfo = `modal ${interaction.data.custom_id.split(":")[0]}`;
            }
            console.error(`Error with InteractionCreate handler [${interactionInfo}]: ${err}`);
        }
    }
};

function validateConfigPermissions(
    config: Pick<EnsnareConfig, "log_channel_id" | "action" | "experiments">,
    channels: string[],
    channelResolvable: Record<string, APIInteractionDataResolvedChannel> | undefined,
    memberPermissions: string | undefined,
    appPermissions: string,
): string[] {
    const errors: string[] = [];
    const ch = (id: string) => channelResolvable?.[id]; 8
    const need = (ok: boolean, msg: string) => { if (!ok) errors.push(msg); };
    const issue = (msg: string) => errors.push(msg);

    const channelPerms = PermissionFlagsBits.SendMessages | PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ManageChannels;
    for (const id of channels) {
        const userPerms = BigInt(ch(id)?.permissions || "0");
        // @ts-expect-error - should be documented soon:tm:
        const appPerms = BigInt(ch(id)?.app_permissions || "0");

        need(hasPermission(userPerms, channelPerms),
            `You don’t have enough permissions to set the ensnare channel to <#${id}>. You need the following permissions in that channel: Send Messages, View Channel, Manage Messages, Manage Channels.`);
        need(hasPermission(appPerms, PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages),
            `I don’t have enough permissions to set the ensnare channel to <#${id}>. I need the following permissions in that channel: View Channel, Send Messages.`);

        if (config.experiments.includes("random-channel-name") || config.experiments.includes("random-channel-name-chaos")) {
            need(hasPermission(appPerms, PermissionFlagsBits.ManageChannels),
                `I need the Manage Channels permission in <#${id}> to enable the “Random Channel Name” experiment.`);
        }
        if (config.experiments.includes("recreate-channel")) {
            need(hasPermission(appPerms, PermissionFlagsBits.ManageChannels),
                `I need the Manage Channels permission in <#${id}> (and globally) to enable the “Channel Recreate” experiment.`);
        }
        if (config.experiments.includes("forward-message")) {
            need(hasPermission(appPerms, PermissionFlagsBits.ReadMessageHistory),
                `I need the Read Message History permission in <#${id}> to enable the “Forward Message” experiment.`);
        }
        if (config.experiments.includes("ensure-msg-delete")) {
            need(hasPermission(appPerms, PermissionFlagsBits.ManageMessages),
                `I need the Manage Messages permission in <#${id}> (and other channels) to enable the “Ensure Message Delete” experiment.`);
        }
    }

    if (config.log_channel_id) {
        const logCh = ch(config.log_channel_id);
        const logPerms = PermissionFlagsBits.SendMessages | PermissionFlagsBits.ViewChannel;

        need(hasPermission(BigInt(logCh?.permissions || "0"), logPerms),
            `You don’t have enough permissions to set the log channel to <#${config.log_channel_id}>. You need the following permissions in that channel: Send Messages, View Channel.`);
        // @ts-expect-error - should be documented soon:tm:
        need(hasPermission(BigInt(logCh?.app_permissions || "0"), logPerms),
            `I don’t have enough permissions to set the log channel to <#${config.log_channel_id}>. I need the following permissions in that channel: Send Messages, View Channel.`);

        // @ts-expect-error - nsfw prop does exist, not sure why not documented
        if (config.experiments.includes("forward-message") && logCh && !logCh.nsfw) {
            // @ts-expect-error - nsfw prop does exist, not sure why not documented
            const nsfwChannels = channels.filter(id => ch(id)?.nsfw === true);
            if (nsfwChannels.length > 0) {
                issue(`<#${config.log_channel_id}> is not marked as NSFW, but the following ensnare channels are: ${nsfwChannels.map(id => `<#${id}>`).join(", ")}. You cannot forward messages from NSFW channels to a non-NSFW channel.`);
            }
            // @ts-expect-error - should be documented soon:tm:
            need(hasPermission(BigInt(logCh?.app_permissions || "0"), PermissionFlagsBits.EmbedLinks),
                `I need the Embed Links permission in <#${config.log_channel_id}> to enable the “Forward Message” experiment.`);
        }
    }

    const banActions = ["ban", "softban"];
    if (banActions.includes(config.action)) {
        need(!memberPermissions || hasPermission(BigInt(memberPermissions), PermissionFlagsBits.BanMembers),
            `You need the Ban Members permission to set the ensnare action to “${config.action}”.`);
        need(hasPermission(BigInt(appPermissions), PermissionFlagsBits.BanMembers),
            `I need the Ban Members permission to set the ensnare action to “${config.action}”.`);
    }

    if (config.experiments.includes("reinvite") && channels[0]!) {
        const inviteCh = ch(channels[0]);
        need(!inviteCh || hasPermission(BigInt(inviteCh.permissions), PermissionFlagsBits.CreateInstantInvite),
            `You need the Create Invite permission in <#${inviteCh?.id}> to enable the “Reinvite” experiment.`);
        // @ts-expect-error - should be documented soon:tm:
        need(!inviteCh || hasPermission(BigInt(inviteCh.app_permissions || "0"), PermissionFlagsBits.CreateInstantInvite),
            `I need the Create Invite permission in <#${inviteCh?.id}> to enable the “Reinvite” experiment.`);
    }

    if (config.experiments.includes("timeout-first")) {
        need(!memberPermissions || hasPermission(BigInt(memberPermissions), PermissionFlagsBits.ModerateMembers),
            `You need the Timeout Members permission to enable the “Timeout First” experiment.`);
        need(hasPermission(BigInt(appPermissions), PermissionFlagsBits.ModerateMembers),
            `I need the Timeout Members permission to enable the “Timeout First” experiment.`);
    }

    if (config.experiments.includes("no-dm") && config.experiments.includes("reinvite")) {
        issue(`“No DM” and “Reinvite” experiments are mutually exclusive.`);
    }
    if (config.experiments.includes("forward-message") && config.experiments.includes("ensure-msg-delete")) {
        issue(`“Forward Message” and “Ensure Message Delete” experiments are mutually exclusive.`);
    }
    if (config.experiments.includes("forward-message") && !config.log_channel_id) {
        issue(`“Forward Message” experiment requires a log channel to be set.`);
    }

    return errors;
}

export default handler;
