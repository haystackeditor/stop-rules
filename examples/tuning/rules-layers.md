# A rule of the kind that does not work: the answer depends on which folder the file is in

- A request handler must not touch storage. A handler calls a service, and only a service
  may read or write the database.
