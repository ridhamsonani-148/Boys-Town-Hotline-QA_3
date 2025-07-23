import { useState } from 'react';
import Navbar from './components/navbar';
import UploadPage from './pages/UploadPage';
import DashboardPage from './pages/DashboardPage';

function App() {
  const [activeTab, setActiveTab] = useState('upload');

  return (
    <div style={{ background: 'linear-gradient(to bottom, #ffffff 0%, #e1f3fc 66.346%)', minHeight: '100vh' }}>
      <Navbar activeTab={activeTab} setActiveTab={setActiveTab} />
      <div style={{ marginTop: '99px' }}>
        {activeTab === 'upload' ? <UploadPage /> : <DashboardPage />}
      </div>
    </div>
  );
}

export default App;