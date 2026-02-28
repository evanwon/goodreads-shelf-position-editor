# Goodreads Shelf Position Editor

A Firefox extension that lets you view and set your **To Read shelf position** directly from any Goodreads book page.

If you maintain a large To Read list sorted by position (priority), Goodreads makes it painful to set a book's position — you have to navigate to your shelf, search for the book, and the search results don't even show the position column. This extension adds a small widget right on the book's detail page.

## What It Does

When you visit a book page on Goodreads (e.g. `goodreads.com/book/show/12345`), a small widget appears showing loading progress, then:

- **On your shelf**: `SHELF POSITION — Position: [ 42 ] [Save] [↻]`
- **Not on your shelf**: `SHELF POSITION — Not on your To Read shelf`

Change the number, hit Enter or click Save, and you're done. Click ↻ to refresh the position from your shelf.

## Install

This is a temporary add-on (not published to AMO).

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `manifest.json` from this repo

The extension will remain active until you restart Firefox.

## Usage

- Visit any book page on `goodreads.com`
- The widget appears immediately with loading progress
- If the book is on your To Read shelf, edit the position and press **Enter** or click **Save**
- If the book is not on your shelf, the widget tells you
- Green flash = saved successfully

## How It Works

1. Extracts the book ID from the page URL
2. Searches your To Read shelf to confirm the book is there
3. Looks up the book's shelf position (cached after first run for speed)
4. Injects a position input widget on the page
5. Saves position changes via Goodreads' internal API

First load may take a few seconds (fetches your shelf data). Subsequent visits to any book page are instant thanks to localStorage caching. Cache expires after 1 week by default — configurable in the extension's options (Add-ons Manager → Goodreads Shelf Position Editor → Options). If you reorder your shelf on goodreads.com, click the ↻ button on the widget to refresh.

## Requirements

- Firefox (tested with temporary add-on loading)
- A Goodreads account with books on your To Read shelf
