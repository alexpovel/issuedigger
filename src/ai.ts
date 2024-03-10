import { Ai } from "@cloudflare/ai";
import { average } from "./vectors";

export async function embed(text: string, ai: Ai) {
  const embeddingModel = "@cf/baai/bge-large-en-v1.5";

  console.info("Embedding text", JSON.stringify(text));
  // The following allocates, which is inefficient, but the alternative is a bunch of
  // ugly code for a custom iterator.
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  console.info(`Split text into ${paragraphs.length} paragraphs`);

  const vectors = await Promise.all(
    paragraphs.map(async (paragraph, index) => {
      console.info(`Paragraph no. ${index}: `, JSON.stringify(paragraph));

      const doEmbed = async (text: string) => {
        const embedding = await ai.run(embeddingModel, {
          text: text,
        });

        return embedding.data[0];
      };

      try {
        return await doEmbed(paragraph);
      } catch (e) {
        console.error(`Error embedding paragraph ${index}:`, e);
        console.warn("Fallback on summarization");

        try {
          const summary = await summarize(paragraph, ai);
          return await doEmbed(summary);
        } catch (e) {
          // Unsure under which conditions this might happen 🤷‍♀️ Perhaps for very long
          // code blocks such as log output in issues? Don't have checked exceptions or
          // errors-as-values here.
          console.error(`Error embedding summary of paragraph ${index}:`, e);
          console.warn("Skipping paragraph");

          // This leaves this entry as undefined.
        }
      }
    })
  );

  const filteredVectors = vectors.filter(
    (item): item is number[] => item !== undefined
  );

  console.info("Got all embeddings");

  return average(filteredVectors);
}

export async function summarize(text: string, ai: Ai) {
  try {
    const summary = await ai.run("@cf/facebook/bart-large-cnn", {
      input_text: text,
    });

    console.info("Got summary", summary.summary);
    return summary.summary;
  } catch (error) {
    console.error("Error retrieving summary: ", error);
    throw error;
  }
}
