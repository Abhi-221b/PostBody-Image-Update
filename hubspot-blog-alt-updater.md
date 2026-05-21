$env:START=1; $env:END=6; node update-alts.js
$env:LOG_FILE="changed-posts-1-6.json"; node push-live.js