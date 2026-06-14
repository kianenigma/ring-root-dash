 Add a feature where we attempt to store the scraped blocks in a web-page local database (there is some database for webpages, for data that is too large to fit in the local storage, what is its name?)

  As we scrape any range, we put it there.

  As we click +1d or similar, The logic remains the same, except if we have already indexed that block, we skip it. It is basically a local cache that prevents us from needing to re-do the network query.

  Show a small stat of the size of the db, number of blocks in it, and a clear button that deletes it.

  If the cache is ever incompatible becase we added more features, assume we have to wipe it. Don't think about migrations and so on. If possible add a schema or sth that detects that the cache is invaid, and is automatically ignored.
