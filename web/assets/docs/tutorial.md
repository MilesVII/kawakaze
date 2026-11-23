Hi! I'll try to keep it short.

# How do LLMs work in roleplay
During roleplay session the <abbr title="A website or an app like JanitorAI, Saucepan, SillyTavern, Ägir and Kawakaze, that offers an interface to interact with LLMs and stores chats and other settings.">RP frontend</abbr> sends chat contents to the <abbr title="Large Language Model, also referred by &quot;AI&quot;, &quot;chat bot&quot;, the model, etc. A program that generates text.">LLM</abbr> via services like OpenRouter and asks it to write a response. Chat contents are just a list of messages, where each message <abbr title="There are others like &quot;tool&quot; and &quot;developer&quot;, which aren't relevant for roleplay">has a role</abbr> specified: `"user"`, `"assistant"` (sometimes `"model"`), and `"system"`. The first two roles are what you see in the chat interface. The `system` messages contain instructions that include descriptions of characters and roleplaying rules. These are composed mostly from what creator provides in the character description.

# What macros are
When user starts a chat with a character, the <abbr title="A website or an app like JanitorAI, SillyTavern, Ägir and Kawakaze, that offers an interface to interact with LLMs and stores chats and other settings.">RP frontend</abbr> takes its definition and replaces the macros like `{{user}}` and `{{char}}` with actual names and pronouns from user's persona.

Macros simply indicate the spots where text needs to be replaced. They are not treated in any special way by the LLM. Many authors write something like "`{{char}} is Mika`" in their character definitions, apparently expecting it to do some kind of magic trick, while in reality, the frontend converts it to `Mika is Mika` the moment user starts a chat. So don't do that.

# I was making bots on Janitor/Saucepan/other platform before, how Kawakaze is different?
Not by much, but there is one key difference: On websites like Janitor, to make a bot, you fill in multiple sections like "Personality", "Scenario", and "Example dialogs". Janitor takes those texts and combines them into a single system message like this:
```
<Mika's persona>
The text you put into "Personality" section
</Mika's persona>
<User's persona>
The description of the persona user picked
</User's persona>
<Scenario>
The text you put into "Scenario" section
</Scenario>
<Example dialogs>
The text you put into "Example dialogs" section
</Example dialogs>
```
It's made this way to guide you and tp signal what needs to be written in a prompt for the LLM to work. However, it also limits your options if you have, say, multiple characters or want to provide special instructions. Most character cards end up having <abbr title="LLM instructions">prompts</abbr> like
```
<Alice & Bob's persona>
...
</Alice & Bob's persona>
...
<Scenario>
Feel free to introduce other characters when situation allows it. Never speak for the user.
</Scenario>
```

It still works, LLMs are smart enough to figure what it means, but it certainly doesn't help and it simply *feels wrong*.

Meanwhile, on Kawakaze, you control the whole prompt that is sent to the LLM, there are no tricks going on under the hood:
```md
# Characters
## {{char}}
{{char}} is 1337 years old evil witch.

## {{user}}
{{persona}}

# Scenario
The setting is modern.

# Instructions
The user is {{user}}; all other characters are played by you.
```

That gives you complete freedom: user's persona is just one of the characters on the list, you can add multiple characters easily, and you are free to add or remove any sections you want, there is no strict format that you have to follow. All that allows you to do things like this:
```md
## Alice
a 1337 years old evil witch.

## Bob
Alice's landlord.

## {{user}}
{{persona}}
Cursed by Alice to have {{poss}} feet constantly itchy.

## {{user}}'s evil clone
Looks like user but with glowing red eyes. Serves Alice.
```

You may have noticed that while Janitor's prompts are formatted with angle brackets, Kawakaze examples use [markdown](https://www.markdownguide.org/cheat-sheet/) headers. There's no meaningful difference between these styles and it's a matter of taste. LLMs don't have any special instruments to read what is written in these messages: an LLM reads and understand these prompts in roughly the same manner that a human would.
