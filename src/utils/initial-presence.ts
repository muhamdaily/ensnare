import { ActivityType, PresenceUpdateStatus } from "discord-api-types/v10";

const initialPresence = {
    since: null,
    activities: [
        {
            name: "#ensnare",
            state: "Watching #ensnare for bots",
            type: ActivityType.Custom,
        }
    ],
    status: PresenceUpdateStatus.Online,
    afk: false,
}

export default initialPresence;
