const { join } = require("path");
if (
	!!process.env.NODE_ENV ||
	["development", "test"].includes(process.env.NODE_ENV)
) {
	require("dotenv").config({ path: join(__dirname, ".env") });
}

// WIN-10: Check port usage
// Get-Process -Id (Get-NetTCPConnection -LocalPort 3002).OwningProcess
module.exports = {
	apps: [
		{
			name: "scws",
			script: "index.js",
			watch: false,
			instances: "max",
			// A V8 abort in one worker must come back. The old false setting
			// left the stream server dead after the cork/write crash.
			autorestart: true,
			max_restarts: 100000,
			min_uptime: 10000,
			restart_delay: 1000,
			exp_backoff_restart_delay: 200,
			exec_mode: "cluster",
			env: {
				HOST: "0.0.0.0",
				PORT: "4001",
			},
		},
	],
};
