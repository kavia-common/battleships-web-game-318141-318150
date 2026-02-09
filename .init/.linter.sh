#!/bin/bash
cd /home/kavia/workspace/code-generation/battleships-web-game-318141-318150/battleships_frontend
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

