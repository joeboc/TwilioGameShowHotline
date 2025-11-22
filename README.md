Pictionary Hotline

The Pictionary Hotline is a small cooperative game built around the Twilio Conversation Relay. The idea is simple: one player acts as the guesser speaking their guesses of what the word to be drawn is, the other draws a word based on the callers theme, both enter the same room code, and the two of them play Pictionary together. The caller hears instructions and guesses the word out loud, while the drawer sees a hidden word and sketches it on the site.

How It Works

The caller dials the Twilio number linked to the game.

They type in a room code on the keypad followed by the pound (#) symbol

Meanwhile, the drawer visits the website, enters the same room code, and chooses their role.

The server connects the two players in that room.

The caller says a theme (such as “Early 2000s Nickelodeon shows” or “Wonders of the World”).

The server picks a word based on that theme and shows it only to the drawer.

The drawer sketches the word on the canvas.

The caller guesses out loud. Twilio sends the recognized text to the server, which updates the drawer’s screen in real time.

Multiple groups can play at the same time, each with their own room code.

Features

Real-time drawing synced between browser clients.

Speech to text from Twilio’s ConversationRelay.

Room based system so multiple people can play independently.

Optional text to speech button for drawers who want to send typed hints to the caller.

Using the Hosted Version

The hosted version behaves just like the local version, except everything is running on a single public server. Players only need:

The website URL

The Twilio phone number attached to the project

A shared room code

There’s nothing else to install.

Local Development (Optional)

If someone wants to run their own copy of this project, here are some instructions to get you started:

Install dependencies
npm install

Environment variables

Create a .env file with:

PORT=3000
NGROK_URL=yourngrokurl
OPENAI_API_KEY=optionalkeyforwordgeneration
(If no open AI key is given the base word list will be used)

Run the server
node server.js

Expose it to Twilio
ngrok http 3000


Then set your Twilio number’s incoming call webhook to:

https://yourngrokurl/twiml
