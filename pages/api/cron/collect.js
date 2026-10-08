import { isAuthorized, runCron } from '../../../lib/cron.js';

export default async function handler(req, res) {
  if (!isAuthorized(req.headers.authorization)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.status(200).json(runCron());
}
