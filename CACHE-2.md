 Now we might have the sitaution, where our timeframe is:

  [not indexed, indexed_start, ..., indexed_end, ..., tip of the chain]

  And I am not sure if we handle it right.

  The right logic is:

  The startup logic is now:

  1. IF we don't have anything indexed: scrape 1h
  2. If we have something scraped: scrape from tip to its end (latest block), and stop. THen load 1h will only load from index_start backwards. While doing this we don't update the UI, because it can be tricky to do so.

  IN all of this, ensure that once the startup phase is done, our range of AH and PC blocks are CONTIGUOS + MATCH. This is critical.
