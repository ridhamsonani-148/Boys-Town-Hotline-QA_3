// Service for handling file uploads and API communication

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'https://td86a455og.execute-api.us-east-1.amazonaws.com/prod/';
const AWS_REGION = process.env.REACT_APP_AWS_REGION;
const API_KEY = process.env.REACT_APP_AWS_API_KEY;

export const uploadService = {
  // Upload file to S3 using presigned URL
  async uploadFile(file, onProgress, onStatusChange) {
    //console.log(`Starting upload for file: ${file.name} (${file.size} bytes)`);
    
    try {
      // Get presigned URL
      onProgress?.(10);
      const urlResponse = await fetch(`${API_BASE_URL}generate-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fileName: file.name,
          fileType: file.type
        })
      });
      
      if (!urlResponse.ok) {
        throw new Error(`Failed to get presigned URL with status: ${urlResponse.status}`);
      }
      
      const { uploadUrl } = await urlResponse.json();
      onProgress?.(30);
      
      // Upload file to S3 with progress simulation
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const progress = Math.round(30 + (e.loaded / e.total) * 70);
            onProgress?.(progress);
          }
        });
        
        xhr.addEventListener('load', async () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            onProgress?.(100);
            
            // Wait 5 minutes then get results
            setTimeout(async () => {
              try {
                const results = await this.getResults(file.name);
                onStatusChange?.('completed', results);
                this.statusChangeCallback?.('completed', results);
              } catch (error) {
                console.error('Error getting results after upload:', error);
                onStatusChange?.('failed', null);
                this.statusChangeCallback?.('failed', null);
              }
            }, 240000);
            
            resolve({ success: true, fileName: file.name, fileSize: file.size });
          } else {
            reject(new Error(`Failed to upload file with status: ${xhr.status}`));
          }
        });
        
        xhr.addEventListener('error', () => {
          reject(new Error('Upload failed'));
        });
        
        xhr.open('PUT', uploadUrl);
        xhr.send(file);
      });
    } catch (error) {
      console.error('Upload error:', error.message);
      throw error;
    }
  },

  // Get results from API
  async getResults(originalFileName) {
    const fileName = `aggregated_${originalFileName.replace('.wav', '')}.json`;
    //console.log(`Fetching results for fileName: ${fileName}`);
    
    try {
      const response = await fetch(`${API_BASE_URL}get-results?fileName=${encodeURIComponent(fileName)}`);
      
      if (!response.ok) {
        throw new Error(`Failed to get results. Status: ${response.status}`);
      }
      
      const results = await response.json();
      //console.log('Results retrieved successfully:', results);
      return results;
    } catch (error) {
      console.error('Error fetching results:', error.message);
      throw error;
    }
  },

  // Set status change callback
  setStatusChangeCallback(callback) {
    this.statusChangeCallback = callback;
  },

  // Get analysis results
  async getAnalysisResults(fileId) {
    //console.log(`Fetching analysis results for fileId: ${fileId}`);
    try {
      const response = await fetch(`${API_BASE_URL}/analysis/${fileId}`, {
        headers: {
          'x-api-key': API_KEY
        }
      });
      
      if (!response.ok) {
        console.error(`Failed to get analysis results. Status: ${response.status}`);
        throw new Error(`Failed to get analysis results. Status: ${response.status}`);
      }
      
      const results = await response.json();
      //console.log('Analysis results retrieved successfully:', results);
      return results;
    } catch (error) {
      console.error('Error fetching analysis results:', error.message);
      throw error;
    }
  },

  // Simulate upload progress (for demo purposes)
  simulateUpload(file, onProgress) {
    //console.log(`Simulating upload for file: ${file.name} (${file.size} bytes)`);
    return new Promise((resolve) => {
      let progress = 0;
      const interval = setInterval(() => {
        progress += 10;
        //console.log(`Upload progress: ${progress}%`);
        onProgress(progress);
        
        if (progress >= 100) {
          clearInterval(interval);
          const result = {
            success: true,
            fileId: Date.now().toString(),
            fileName: file.name,
            fileSize: file.size
          };
          //console.log('Simulated upload complete:', result);
          resolve(result);
        }
      }, 200);
    });
  }
};