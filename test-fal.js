const { fal } = require('@fal-ai/client');

fal.config({ credentials: process.env.FAL_API_KEY });

async function test() {
  console.log('Testing FAL_API_KEY...');
  const result = await fal.subscribe('fal-ai/flux/dev', {
    input: {
      prompt: 'a red circle on a white background',
      image_size: { width: 256, height: 256 },
      num_images: 1,
      num_inference_steps: 4,
    },
  });
  console.log('Success! Preview URL:', result.data.images[0].url);
}

test().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
