@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist data\gesty.db call npm run seed
start "" http://localhost:3000
node server.js
pause
