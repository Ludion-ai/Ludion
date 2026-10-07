// The lessons org and repo live in ludion.config.json only (CLAUDE.md); bundled at deploy.
import config from "../../../ludion.config.json";

export const LESSONS_ORG: string = config.org;
export const LESSONS_REPO: string = config.repo;
