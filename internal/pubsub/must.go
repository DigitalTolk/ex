package pubsub

// mustJSON unwraps a json.Marshal whose error arm is impossible by
// construction (e.g. a struct of strings plus a json.RawMessage that is itself
// json.Marshal output). If the impossible ever happens it panics rather than
// publishing a corrupt frame.
func mustJSON(data []byte, err error) []byte {
	if err != nil {
		panic(err)
	}
	return data
}
