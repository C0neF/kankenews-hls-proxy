const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  Referer: 'https://live.kankanews.com/',
  Origin: 'https://live.kankanews.com',
  'User-Agent': USER_AGENT,
};

module.exports = { USER_AGENT, COMMON_HEADERS };
