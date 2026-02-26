# GR Shelf Position Editor

A Firefox extension that lets you view and set your **To Read shelf position** directly from any Goodreads book page.

If you maintain a large To Read list sorted by position (priority), Goodreads makes it painful to set a book's position — you have to navigate to your shelf, search for the book, and the search results don't even show the position column. This extension adds a small widget right on the book's detail page.

## What It Does

When you visit a book page on Goodreads (e.g. `goodreads.com/book/show/12345`), the extension checks if the book is on your To Read shelf. If it is, a widget appears:

```
To Read position: [ 42 ] [Save]
```

Change the number, hit Enter or click Save, and you're done.

## Install

This is a temporary add-on (not published to AMO).

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `gr-shelf-position-editor/manifest.json`

The extension will remain active until you restart Firefox.

## Usage

- Visit any book page on `goodreads.com`
- If the book is on your To Read shelf, the position widget appears automatically
- Edit the position number and press **Enter** or click **Save**
- Green flash = saved successfully

## How It Works

1. Extracts the book ID from the page URL
2. Searches your To Read shelf to confirm the book is there
3. Looks up the book's shelf position (cached after first run for speed)
4. Injects a position input widget on the page
5. Saves position changes via Goodreads' internal API

First load may take a few seconds (fetches your shelf data). Subsequent visits to any book page are instant thanks to localStorage caching.

## Requirements

- Firefox (tested with temporary add-on loading)
- A Goodreads account with books on your To Read shelf
