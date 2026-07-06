
CREATE POLICY "Auth read post images" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'post-images');
