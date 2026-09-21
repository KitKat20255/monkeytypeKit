# monkeytypeKit

I am NOT a programmer, everything was coded with the help of the AI.

What this addon does:

1. allows you to preset different bigrams or words that you want to have highlighted in tests.
 Different bigrams can be attached to different tags, so you can highlight different alt finger keys for different layouts.

2. Displays total lifetime keys pressed in bottom left, and extra calorie expenditure depending of the body you input. It should last indefinitley, assuming there are no bugs.

3. Allows you to enable jail, which will collect any incorrect words from quote mode. It will create a "jail" list under custom. You need to refresh your browser to have the latest version of it. You can select how many times each word to be populated in jail mode, and you must type each word that amount of times to be removed from jail. If you don't, at the end of the custom test, a new jail will have remaining words, refresh again.

4. Archive mode. Supposedly imports and lasts forever, and auto updates every 6 hours if you have the site open.

There are charts for everything you select, and daily, monthly averages, with a new metric stumble (it tells you how many words had one or more mistakes in a test)

 Also there is an improvement rate graph, which will compare your average gain/loss every 10 hours in the selected filters.

5. Go in monkeytype in account settings, on left side and create an ape key, save it, and activate it.

Refresh monkeytype and click bottom right on archive, click on the ape key at the top and insert your key there.

6. You can enable dictation mode, it's not brilliant but kinda works, it's only usable in custom mode, generate a text but remove all punctuation other than ' else you'll have a hard time. You have some settings you can play with, to trigger more or less words, faster or slower, and a repeat combo for when you forgot what you had to write.

For dictation, you need to install a prepackaged kokoro server from https://hub.docker.com/r/hwdsl2/kokoro-server

Install it, it will ask you to create an user/use existing google and verify.

After you're verified, have the docker running, and in containers you will see kokoro-tts container active. Delete it, then open command.com and run 

docker run -d -p 8880:8880 --name kokoro-tts -e KOKORO_API_KEY="monkeytypeuser" hwdsl2/kokoro-server:latest

It should start a new kokoro-tts container in the docker. It needs to be running in order for you to hear the dictation while you type in monkeytype.

Enjoy :)
