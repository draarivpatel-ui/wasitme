- **The Mac app's Control Center stops retrying a canvas that keeps stopping, and says so.** When the canvas's web
  content process stops before the page comes up, the app loads it again up to three times in a row; after that the
  window says the canvas isn't shown instead of staying blank while new processes are started over and over, and
  closing and reopening the window tries once more. A canvas that came up and was later reclaimed by the system is
  reloaded as before.
