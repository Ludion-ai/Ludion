// The lessons org and repo live in ludion.config.json only (CLAUDE.md); bundled at deploy.
import config from "../../../ludion.config.json";

export const LESSONS_ORG: string = config.org;
export const LESSONS_REPO: string = config.repo;
/** The Ludion App's bot account id; absent until the App exists (step 6). Teaching stays closed without it. */
export const APP_BOT_ID: number | undefined = (config as { app_bot_id?: number }).app_bot_id;
